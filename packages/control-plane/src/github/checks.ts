import type { GateVerdict, Run } from "@qa-agent/shared-types";
import type { InstallationOctokit } from "./app";
import type { RepoRef } from "./diff";

export const CHECK_NAME = "Agentic QA Fleet";

/**
 * The gate. We post a check run on the stage branch's head SHA; branch
 * protection on the *next* stage's branch requires this check to pass, so a
 * "block" verdict stops promotion.
 */
export async function createInProgressCheck(
  octokit: InstallationOctokit,
  ref: RepoRef,
  run: Run,
  detailsUrl: string,
): Promise<number> {
  const { data } = await octokit.rest.checks.create({
    ...ref,
    name: CHECK_NAME,
    head_sha: run.change.headSha,
    external_id: run.id,
    details_url: detailsUrl,
    status: "in_progress",
    started_at: run.startedAt,
    output: {
      title: `Run #${run.number} exploring ${run.change.pullRequests.length} PR(s)`,
      summary: summarizeChange(run),
    },
  });
  return data.id;
}

const CONCLUSION: Record<Exclude<GateVerdict, "pending">, "success" | "failure" | "neutral"> = {
  pass: "success",
  block: "failure",
  override: "neutral",
};

export async function completeCheck(
  octokit: InstallationOctokit,
  ref: RepoRef,
  run: Run,
  detailsUrl: string,
): Promise<void> {
  if (run.checkRunId === undefined) {
    throw new Error(`Run ${run.id} has no check run to complete`);
  }
  if (run.verdict === "pending") {
    throw new Error(`Run ${run.id} verdict is still pending`);
  }
  await octokit.rest.checks.update({
    ...ref,
    check_run_id: run.checkRunId,
    status: "completed",
    conclusion: CONCLUSION[run.verdict],
    completed_at: run.finishedAt ?? new Date().toISOString(),
    details_url: detailsUrl,
    output: {
      title: run.confidenceStatement ?? `Run #${run.number} ${run.verdict}`,
      summary: summarizeVerdict(run),
    },
  });
}

/** Mark the check failed for infra reasons (not a QA verdict). */
export async function failCheck(
  octokit: InstallationOctokit,
  ref: RepoRef,
  run: Run,
  reason: string,
): Promise<void> {
  if (run.checkRunId === undefined) return;
  await octokit.rest.checks.update({
    ...ref,
    check_run_id: run.checkRunId,
    status: "completed",
    conclusion: "action_required",
    completed_at: new Date().toISOString(),
    output: {
      title: `Run #${run.number} failed to complete`,
      summary: `The QA fleet hit an infrastructure error and produced no verdict.\n\n${codeBlock(reason)}`,
    },
  });
}

/**
 * A deployment whose change context could not be assembled never gets an
 * in-progress check, so post a completed one explaining why. Without it the
 * promotion PR would sit on "Expected — waiting for status" with no reason.
 */
export async function createFailedCheck(
  octokit: InstallationOctokit,
  ref: RepoRef,
  run: Run,
  reason: string,
  detailsUrl: string,
): Promise<number> {
  const { data } = await octokit.rest.checks.create({
    ...ref,
    name: CHECK_NAME,
    head_sha: run.change.headSha,
    external_id: run.id,
    details_url: detailsUrl,
    status: "completed",
    conclusion: "action_required",
    started_at: run.startedAt,
    completed_at: run.finishedAt ?? new Date().toISOString(),
    output: {
      title: `Run #${run.number} could not assemble change context`,
      summary: [
        `Comparing from the deploy cursor \`${run.change.baseSha.slice(0, 7)}\` failed, so no fleet ran.`,
        "The cursor was not advanced; the next push retries from the same base. If the cursor SHA is wrong, reseed it.",
        "",
        codeBlock(reason),
      ].join("\n"),
    },
  });
  return data.id;
}

function codeBlock(text: string): string {
  return ["```", text, "```"].join("\n");
}

function summarizeChange(run: Run): string {
  const c = run.change;
  const lines = [
    `Comparing \`${c.baseSha.slice(0, 7)}...${c.headSha.slice(0, 7)}\``,
    `${c.commitCount} commit(s), ${c.filesChanged} file(s) changed` +
      (c.compareStatus === "diverged" ? " (base diverged; using merge base)" : ""),
    "",
  ];
  if (c.pullRequests.length === 0) {
    lines.push("_No merged pull requests found in this window._");
  } else {
    lines.push("### Pull requests in this deployment");
    for (const pr of c.pullRequests) {
      const labels = pr.labels.length ? ` \`${pr.labels.join("` `")}\`` : "";
      lines.push(`- [#${pr.number}](${pr.url}) ${pr.title} by @${pr.author}${labels}`);
    }
  }
  return lines.join("\n");
}

function summarizeVerdict(run: Run): string {
  const f = run.findings;
  const cov = run.coverage;
  const pct = cov.surfacesTotal ? Math.round((cov.surfacesVisited / cov.surfacesTotal) * 100) : 0;
  return [
    `**Verdict:** ${run.verdict}`,
    `**Coverage:** ${cov.surfacesVisited}/${cov.surfacesTotal} surfaces (${pct}%)`,
    `**Findings:** ${f.total} total (P0 ${f.bySeverity.P0}, P1 ${f.bySeverity.P1}, P2 ${f.bySeverity.P2}, P3 ${f.bySeverity.P3})`,
    `**Fleet:** ${run.fleet.agentsCompleted}/${run.fleet.agentsRequested} agents completed`,
    "",
    summarizeChange(run),
  ].join("\n");
}
