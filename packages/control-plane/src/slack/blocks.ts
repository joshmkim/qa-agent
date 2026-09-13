import type { KnownBlock } from "@slack/web-api";
import type { ChangeContext, Repository, Run, Stage } from "@qa-agent/shared-types";

/** Slack action_id for the "Run QA fleet" button on a deployment message. */
export const RUN_QA_ACTION = "run_qa";

export interface RunQaButtonValue {
  stageId: string;
  headSha: string;
}

/** Slack truncates long messages; keep the PR list bounded. */
const MAX_PRS_LISTED = 10;

export interface SlackMessage {
  /** Plain-text fallback for notifications and clients without Block Kit. */
  text: string;
  blocks: KnownBlock[];
}

const short = (sha: string) => sha.slice(0, 7);

function commitUrl(repo: Repository, sha: string): string {
  return `${repo.url}/commit/${sha}`;
}

function compareUrl(repo: Repository, change: ChangeContext): string {
  return `${repo.url}/compare/${change.baseSha}...${change.headSha}`;
}

function prList(change: ChangeContext): string {
  if (change.pullRequests.length === 0) {
    return "_No merged pull requests found in this window._";
  }
  const lines = change.pullRequests
    .slice(0, MAX_PRS_LISTED)
    .map((pr) => `• <${pr.url}|#${pr.number}> ${escape(pr.title)} — @${pr.author}`);
  const rest = change.pullRequests.length - MAX_PRS_LISTED;
  if (rest > 0) lines.push(`_…and ${rest} more_`);
  return lines.join("\n");
}

function changeSummary(repo: Repository, change: ChangeContext): string {
  const diverged = change.compareStatus === "diverged" ? " (base diverged; used merge base)" : "";
  return (
    `<${compareUrl(repo, change)}|${short(change.baseSha)}…${short(change.headSha)}> · ` +
    `${change.commitCount} commit${plural(change.commitCount)} · ` +
    `${change.filesChanged} file${plural(change.filesChanged)} · ` +
    `${change.pullRequests.length} PR${plural(change.pullRequests.length)}${diverged}`
  );
}

const plural = (n: number) => (n === 1 ? "" : "s");

/** Slack mrkdwn treats &, <, > as control characters. */
function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function header(text: string): KnownBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

/**
 * Posted when a push lands on a stage branch. If the stage auto-runs, the
 * "run started" update replaces this; otherwise it carries a kickoff button.
 */
export function deploymentMessage(input: {
  repository: Repository;
  stage: Stage;
  headSha: string;
  change: ChangeContext;
  source: string;
  autoRun: boolean;
}): SlackMessage {
  const { repository, stage, headSha, change, source, autoRun } = input;
  const title = `New deployment: ${repository.fullName} → ${stage.name}`;
  const value: RunQaButtonValue = { stageId: stage.id, headSha };

  const blocks: KnownBlock[] = [
    header(`🚀 ${title}`),
    section(changeSummary(repository, change)),
    section(prList(change)),
    context(
      `Head <${commitUrl(repository, headSha)}|\`${short(headSha)}\`> on \`${stage.branch}\` · pushed by ${escape(source)}` +
        (stage.environmentUrl ? ` · <${stage.environmentUrl}|open ${stage.name}>` : ""),
    ),
  ];

  if (autoRun) {
    blocks.push(context("⏳ Starting QA fleet…"));
  } else {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: RUN_QA_ACTION,
          text: { type: "plain_text", text: `Run QA fleet (${stage.fleetSize} agents)`, emoji: true },
          style: "primary",
          value: JSON.stringify(value),
        },
      ],
    });
  }

  return { text: title, blocks };
}

/** Context assembly failed; no fleet ran. Short, no button, no thread. */
export function deploymentFailedMessage(input: {
  repository: Repository;
  stage: Stage;
  headSha: string;
  reason: string;
  runUrl: string;
}): SlackMessage {
  const { repository, stage, headSha, reason, runUrl } = input;
  const title = `Couldn't assemble context for ${short(headSha)} on ${repository.fullName} → ${stage.name}`;
  return {
    text: title,
    blocks: [
      section(
        `⚠️ Couldn't assemble context for <${commitUrl(repository, headSha)}|\`${short(headSha)}\`> on ` +
          `\`${stage.branch}\` (${escape(repository.fullName)}). No fleet ran; the next push retries from the same base.`,
      ),
      context(`${escape(reason).slice(0, 300)} · <${runUrl}|view run>`),
    ],
  };
}

/** Replaces the deployment message (or stands alone for manual triggers). */
export function runStartedMessage(input: {
  repository: Repository;
  stage: Stage;
  run: Run;
  runUrl: string;
}): SlackMessage {
  const { repository, stage, run, runUrl } = input;
  const who = run.triggeredBy ? escape(run.triggeredBy) : run.trigger;
  const how =
    run.trigger === "push-webhook"
      ? `auto-started on deployment by ${who}`
      : `started by ${who}`;
  const title = `QA run #${run.number} started: ${repository.fullName} → ${stage.name}`;

  return {
    text: title,
    blocks: [
      header(`🧪 ${title}`),
      section(changeSummary(repository, run.change)),
      section(prList(run.change)),
      context(
        `${run.fleet.agentsRequested} agents · ${how} · <${runUrl}|view run>` +
          (stage.environmentUrl ? ` · <${stage.environmentUrl}|open ${stage.name}>` : ""),
      ),
    ],
  };
}

const VERDICT_EMOJI: Record<Run["verdict"], string> = {
  pass: "✅",
  block: "🛑",
  override: "⚠️",
  pending: "⏳",
};

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

function durationLabel(run: Run): string {
  if (!run.finishedAt) return "";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** Posted in the thread of the run's start message when the fleet finishes. */
export function runReportMessage(input: {
  repository: Repository;
  stage: Stage;
  run: Run;
  runUrl: string;
}): SlackMessage {
  const { repository, stage, run, runUrl } = input;

  if (run.status === "failed") {
    const reason = run.steps.at(-1)?.detail ?? "unknown error";
    const title = `QA run #${run.number} failed to complete: ${repository.fullName} → ${stage.name}`;
    return {
      text: title,
      blocks: [
        header(`💥 ${title}`),
        section(`The fleet hit an infrastructure error and produced no verdict.\n\`\`\`${escape(reason)}\`\`\``),
        context(`<${runUrl}|view run>`),
      ],
    };
  }

  const f = run.findings;
  const c = run.coverage;
  const verdictWord = run.verdict === "block" ? "BLOCKED" : run.verdict.toUpperCase();
  const title = `QA run #${run.number} ${verdictWord}: ${repository.fullName} → ${stage.name}`;

  const blocks: KnownBlock[] = [header(`${VERDICT_EMOJI[run.verdict]} ${title}`)];

  if (run.confidenceStatement) {
    blocks.push(section(`*${escape(run.confidenceStatement)}*`));
  }

  blocks.push({
    type: "section",
    fields: [
      {
        type: "mrkdwn",
        text:
          `*Findings*\n${f.total} total` +
          (f.duplicatesCollapsed ? ` (${f.duplicatesCollapsed} dupes collapsed)` : "") +
          `\nP0 ${f.bySeverity.P0} · P1 ${f.bySeverity.P1} · P2 ${f.bySeverity.P2} · P3 ${f.bySeverity.P3}`,
      },
      {
        type: "mrkdwn",
        text:
          `*Coverage*\n${c.surfacesVisited}/${c.surfacesTotal} surfaces (${pct(c.surfacesVisited, c.surfacesTotal)})` +
          `\n${c.changedSurfacesVisited}/${c.changedSurfacesTotal} changed surfaces · ${c.invariantsChecked}/${c.invariantsTotal} invariants`,
      },
      {
        type: "mrkdwn",
        text: `*Fleet*\n${run.fleet.agentsCompleted}/${run.fleet.agentsRequested} agents completed` +
          (run.fleet.agentsFailed ? `, ${run.fleet.agentsFailed} failed` : "") +
          `\n${run.fleet.totalActions} actions`,
      },
      {
        type: "mrkdwn",
        text: `*Gate*\n${run.verdict === "block" ? "Promotion blocked" : run.verdict === "override" ? "Overridden" : "Promotion allowed"}` +
          (durationLabel(run) ? `\n${durationLabel(run)}` : ""),
      },
    ],
  });

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View report", emoji: true },
        url: runUrl,
        action_id: "view_report",
        ...(run.verdict === "block" ? { style: "danger" as const } : {}),
      },
      {
        type: "button",
        text: { type: "plain_text", text: "View findings", emoji: true },
        url: `${runUrl}/findings`,
        action_id: "view_findings",
      },
    ],
  });

  return { text: title, blocks };
}

/** Ephemeral status reply for `/qa status`. */
export function stageStatusText(input: {
  repository: Repository;
  stage: Stage;
  latest?: Run;
  runUrl?: string;
}): string {
  const { repository, stage, latest, runUrl } = input;
  const head = `*${repository.fullName} → ${stage.name}* (\`${stage.branch}\`)`;
  const cursor = stage.cursor
    ? `cursor \`${short(stage.cursor.sha)}\`${stage.cursor.prNumber ? ` (PR #${stage.cursor.prNumber})` : ""}`
    : "no cursor seeded";
  if (!latest) return `${head}\n${cursor} · no runs yet`;

  const state =
    latest.verdict === "pending"
      ? `${VERDICT_EMOJI.pending} run #${latest.number} ${latest.status}`
      : `${VERDICT_EMOJI[latest.verdict]} run #${latest.number} ${latest.verdict}` +
        ` · ${latest.findings.total} finding${plural(latest.findings.total)}`;
  return `${head}\n${cursor} · ${state}${runUrl ? ` · <${runUrl}|view>` : ""}`;
}
