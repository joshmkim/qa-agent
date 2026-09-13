import type { KnownBlock } from "@slack/web-api";
import type { ChangeContext, Finding, Repository, Run, Severity, Stage } from "@qa-agent/shared-types";

/** Slack truncates long messages; keep the PR list bounded. */
const MAX_PRS_LISTED = 10;

export interface SlackMessage {
  /** Plain-text fallback for notifications and clients without Block Kit. */
  text: string;
  blocks: KnownBlock[];
}

const short = (sha: string) => sha.slice(0, 7);
const plural = (n: number) => (n === 1 ? "" : "s");

function compareUrl(repo: Repository, change: ChangeContext): string {
  return `${repo.url}/compare/${change.baseSha}...${change.headSha}`;
}

/** Slack mrkdwn treats &, <, > as control characters. */
function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function context(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

function header(text: string): KnownBlock {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
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

/**
 * Posted when a deployment's change context could not be assembled (bad
 * cursor SHA, revoked install). No fleet ran and no run report follows; the
 * next push retries from the same base.
 */
export function deploymentFailedMessage(input: {
  repository: Repository;
  stage: Stage;
  headSha: string;
  reason: string;
  runUrl: string;
}): SlackMessage {
  const { repository, stage, headSha, reason, runUrl } = input;
  const title = `Couldn't assemble context for ${short(headSha)}: ${repository.fullName} → ${stage.name}`;
  return {
    text: title,
    blocks: [
      header(`⚠️ ${title}`),
      section(
        `No fleet ran for <${repository.url}/commit/${headSha}|\`${short(headSha)}\`> on \`${stage.branch}\`. ` +
          "The deploy cursor was not advanced, so the next push retries from the same base.\n" +
          `\`\`\`${escape(reason)}\`\`\``,
      ),
      context(`<${runUrl}|view run>`),
    ],
  };
}

/** Posted to the channel when the fleet finishes (verdict or infra failure). */
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
        section(changeSummary(repository, run.change)),
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
        text:
          `*Fleet*\n${run.fleet.agentsCompleted}/${run.fleet.agentsRequested} agents completed` +
          (run.fleet.agentsFailed ? `, ${run.fleet.agentsFailed} failed` : "") +
          `\n${run.fleet.totalActions} actions`,
      },
      {
        type: "mrkdwn",
        text:
          `*Gate*\n${run.verdict === "block" ? "Promotion blocked" : run.verdict === "override" ? "Overridden" : "Promotion allowed"}` +
          (durationLabel(run) ? `\n${durationLabel(run)}` : ""),
      },
    ],
  });

  // What was under test: the PRs in this deployment window.
  blocks.push(section(changeSummary(repository, run.change)));
  blocks.push(section(prList(run.change)));

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

  const who = run.triggeredBy ? escape(run.triggeredBy) : run.trigger;
  blocks.push(
    context(
      `Triggered via ${run.trigger} by ${who}` +
        (stage.environmentUrl ? ` · <${stage.environmentUrl}|open ${stage.name}>` : ""),
    ),
  );

  return { text: title, blocks };
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  P0: "🔴",
  P1: "🟠",
  P2: "🟡",
  P3: "⚪",
};

/**
 * Posted once per finding the first time it becomes a tracker issue (not on
 * a recurrence, which only comments on the existing issue). Provider-agnostic
 * message shape; `finding.trackedIssue` names which tracker actually filed it.
 */
export function findingTrackedMessage(input: {
  repository: Repository;
  stage: Stage;
  run: Run;
  finding: Finding;
  runUrl: string;
  findingUrl: string;
}): SlackMessage {
  const { repository, stage, run, finding, runUrl, findingUrl } = input;
  const issue = finding.trackedIssue;
  if (!issue) {
    throw new Error(`findingTrackedMessage called for finding ${finding.id} with no trackedIssue set`);
  }

  const title = `${issue.key} filed: ${finding.title}`;
  return {
    text: title,
    blocks: [
      header(`${SEVERITY_EMOJI[finding.severity]} New issue filed`),
      section(`*<${issue.url}|${issue.key}>* — ${escape(finding.title)}`),
      context(
        `Surface \`${finding.surfaceId}\` · QA run <${runUrl}|#${run.number}> on ` +
          `\`${stage.branch}\` (${repository.fullName}) · <${findingUrl}|view finding>`,
      ),
    ],
  };
}
