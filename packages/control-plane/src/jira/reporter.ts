import type { Finding, Run, Severity } from "@qa-agent/shared-types";
import type { JiraConfig } from "../config";
import type { EventBus, RunFinished } from "../events";
import type { Store } from "../store";
import { JiraError, type JiraClient } from "./client";
import { dedupeLabel, issueFields, recurrenceComment } from "./issues";

const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

export interface JiraReporterDeps {
  client: JiraClient;
  events: EventBus;
  store: Store;
  config: JiraConfig;
  runUrl: (run: Run) => string;
}

/**
 * Files findings into Jira when a run finishes, so triaged defects land in
 * the backlog the team already works from instead of only in the QA UI.
 *
 * Dedupe lives in Jira: each issue carries a label derived from the
 * finding's `dedupeKey`, so the same defect found again comments on the
 * existing issue instead of filing a duplicate. That survives a control-plane
 * restart, which an in-memory map would not.
 */
export class JiraReporter {
  constructor(private readonly deps: JiraReporterDeps) {}

  start(): () => void {
    const off = this.deps.events.on("run.finished", (e) => this.onRunFinished(e));
    return off;
  }

  /** Findings worth filing: severe enough, and not already dismissed or folded into another. */
  private fileable(findings: Finding[]): Finding[] {
    const floor = SEVERITY_RANK[this.deps.config.minSeverity];
    return findings.filter(
      (f) =>
        SEVERITY_RANK[f.severity] <= floor &&
        f.status !== "dismissed" &&
        f.status !== "duplicate",
    );
  }

  private async onRunFinished(e: RunFinished): Promise<void> {
    // An infra failure produced no verdict and no findings; nothing to file.
    if (e.run.status === "failed") return;

    const findings = this.fileable(await this.deps.store.listFindings(e.run.id));
    if (findings.length === 0) return;

    // Resolved once per run, not once per finding: it's the same answer for
    // every finding in this batch, and a board/sprint lookup is not free.
    const sprintId = await this.deps.client.findActiveSprintId().catch((err) => {
      console.error("[jira] could not resolve the active sprint; new issues will land in the backlog:", describe(err));
      return undefined;
    });

    for (const finding of findings) {
      try {
        await this.fileFinding(finding, e, sprintId);
      } catch (err) {
        // One bad finding must not stop the rest, and must never fail the run.
        console.error(`[jira] could not file finding ${finding.id}:`, describe(err));
      }
    }
  }

  private async fileFinding(finding: Finding, e: RunFinished, sprintId: number | undefined): Promise<void> {
    const { client, store, config, runUrl } = this.deps;
    const runLink = runUrl(e.run);
    const findingUrl = `${runLink}/findings/${finding.id}`;

    const existing = await client.findIssueByLabel(dedupeLabel(finding));
    if (existing) {
      // Already triaged once (someone may have moved, assigned, or started
      // it); a recurrence shouldn't yank it back onto the current sprint.
      await client.addComment(existing, recurrenceComment({ run: e.run, runUrl: runLink, findingUrl }));
      await this.record(finding, existing, `${config.baseUrl}/browse/${existing}`, store);
      console.log(`[jira] ${existing} still reproducing (finding ${finding.id})`);
      return;
    }

    const created = await client.createIssue(
      issueFields({
        finding,
        repository: e.repository,
        stage: e.stage,
        run: e.run,
        findingUrl,
        runUrl: runLink,
        config,
      }),
    );
    await this.record(finding, created.key, created.url, store);
    console.log(`[jira] filed ${created.key} for ${finding.severity} finding ${finding.id}`);

    if (sprintId !== undefined) {
      try {
        await client.addToSprint(created.key, sprintId);
        console.log(`[jira] added ${created.key} to the active sprint`);
      } catch (err) {
        // The issue is already filed and linked; a board placement failure
        // just leaves it in the backlog, which is where it would have
        // started anyway before this feature existed.
        console.error(`[jira] could not add ${created.key} to the active sprint:`, describe(err));
      }
    }
  }

  /** Persist the issue link back onto the finding so the UI can show it. */
  private async record(finding: Finding, key: string, url: string, store: Store): Promise<void> {
    await store.saveFindings(finding.runId, [
      { ...finding, trackedIssue: { provider: "jira", key, url, filedAt: new Date().toISOString() } },
    ]);
  }
}

/** Jira returns the useful part of a failure in the body, not the status line. */
function describe(err: unknown): string {
  if (err instanceof JiraError) {
    return `${err.message} ${err.body.slice(0, 500)}`;
  }
  return err instanceof Error ? err.message : String(err);
}
