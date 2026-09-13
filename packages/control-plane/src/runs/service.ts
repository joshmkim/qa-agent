import { randomUUID } from "node:crypto";
import {
  isRunActive,
  type ChangeContext,
  type CoverageSummary,
  type Finding,
  type FindingCounts,
  type FleetSummary,
  type GateVerdict,
  type Repository,
  type Run,
  type RunStatus,
  type RunStep,
  type Stage,
} from "@qa-agent/shared-types";
import type { EventBus } from "../events";
import type { GitHubApp } from "../github/app";
import { completeCheck, createFailedCheck, createInProgressCheck, failCheck } from "../github/checks";
import { computeChangeContext } from "../github/diff";
import type { Store } from "../store";

export interface RunServiceDeps {
  store: Store;
  github: GitHubApp;
  events: EventBus;
  /** Builds the human-facing URL for a run (web UI), used in check runs and Slack. */
  runUrl: (run: Run) => string;
}

export interface StartRunInput {
  stage: Stage;
  headSha: string;
  trigger: Run["trigger"];
  triggeredBy?: string;
  /** Skip the GitHub compare if the caller already computed it. */
  change?: ChangeContext;
  /** Set on re-runs; recorded on the new run. */
  rerunOf?: string;
  /** Start without advancing the cursor (re-runs of a window already deployed). */
  keepCursor?: boolean;
}

export interface CompleteRunInput {
  verdict: Exclude<GateVerdict, "pending">;
  confidenceStatement?: string;
  confidenceScore?: number;
  /** Derived from stored findings when omitted, so counts and findings can't disagree. */
  findings?: FindingCounts;
  coverage: CoverageSummary;
  fleet: FleetSummary;
}

export class RunError extends Error {
  constructor(
    message: string,
    readonly code:
      | "stage-not-found"
      | "repository-not-found"
      | "no-cursor"
      | "cursor-conflict"
      | "run-not-found"
      | "run-not-active",
  ) {
    super(message);
    this.name = "RunError";
  }
}

const EMPTY_FLEET: FleetSummary = {
  agentsRequested: 0,
  agentsCompleted: 0,
  agentsFailed: 0,
  dispositions: {},
  totalActions: 0,
};
const EMPTY_COVERAGE: CoverageSummary = {
  surfacesTotal: 0,
  surfacesVisited: 0,
  changedSurfacesTotal: 0,
  changedSurfacesVisited: 0,
  invariantsTotal: 0,
  invariantsChecked: 0,
};
const EMPTY_FINDINGS: FindingCounts = {
  bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 },
  total: 0,
  duplicatesCollapsed: 0,
};

/**
 * Gate counts exclude duplicates and dismissed findings. `duplicatesCollapsed`
 * is the sum of each canonical finding's `triage.duplicateCount`; duplicate
 * rows stored alongside (so the UI can show who else hit it) are those same
 * duplicates and are not counted again.
 */
export function countFindings(findings: Finding[]): FindingCounts {
  const counts: FindingCounts = { bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 }, total: 0, duplicatesCollapsed: 0 };
  for (const f of findings) {
    if (f.status === "duplicate" || f.status === "dismissed") continue;
    counts.bySeverity[f.severity] += 1;
    counts.total += 1;
    counts.duplicatesCollapsed += f.triage?.duplicateCount ?? 0;
  }
  return counts;
}

/**
 * Run lifecycle. Deployments come in from the GitHub push webhook or an
 * explicit API/Slack trigger; runs are completed by the orchestrator once
 * triage finishes. Every transition emits an event for integrations.
 */
export class RunService {
  constructor(private readonly deps: RunServiceDeps) {}

  private async repoFor(stage: Stage): Promise<Repository> {
    const repo = await this.deps.store.getRepository(stage.repositoryId);
    if (!repo) {
      throw new RunError(`Repository ${stage.repositoryId} not found`, "repository-not-found");
    }
    return repo;
  }

  async resolveStage(repoFullName: string, stageName: string): Promise<{ repository: Repository; stage: Stage }> {
    const repository = await this.deps.store.getRepositoryByFullName(repoFullName);
    if (!repository) {
      throw new RunError(`Repository ${repoFullName} is not connected`, "repository-not-found");
    }
    const stages = await this.deps.store.listStages(repository.id);
    const stage = stages.find((s) => s.name.toLowerCase() === stageName.toLowerCase());
    if (!stage) {
      const names = stages.map((s) => s.name).join(", ") || "none configured";
      throw new RunError(`Stage "${stageName}" not found on ${repoFullName} (stages: ${names})`, "stage-not-found");
    }
    return { repository, stage };
  }

  /** Current head SHA of the stage's deployment branch. */
  async branchHead(stage: Stage): Promise<string> {
    const repo = await this.repoFor(stage);
    const octokit = await this.deps.github.getInstallationOctokit(repo.installationId);
    const { data } = await octokit.rest.repos.getBranch({
      owner: repo.owner,
      repo: repo.name,
      branch: stage.branch,
    });
    return data.commit.sha;
  }

  /** Diff from `baseSha` (default: the stage cursor) to `headSha`. */
  async computeChange(stage: Stage, headSha: string, baseSha = stage.cursor?.sha): Promise<ChangeContext> {
    if (!baseSha) {
      throw new RunError(
        `Stage ${stage.name} has no deploy cursor yet; seed one before running`,
        "no-cursor",
      );
    }
    const repo = await this.repoFor(stage);
    const octokit = await this.deps.github.getInstallationOctokit(repo.installationId);
    return computeChangeContext(
      octokit,
      { owner: repo.owner, repo: repo.name },
      baseSha,
      headSha,
    );
  }

  /**
   * A new head landed on a stage branch. Announces it, and starts a run when
   * the stage is configured to auto-run. Returns the run if one started.
   */
  async detectDeployment(stage: Stage, headSha: string, source: string): Promise<Run | undefined> {
    const repository = await this.repoFor(stage);
    let change: ChangeContext;
    try {
      change = await this.computeChange(stage, headSha);
    } catch (err) {
      // Our own precondition failures (no cursor, unknown repo) stay errors.
      if (err instanceof RunError) throw err;
      await this.recordFailedDeployment(repository, stage, headSha, source, err);
      return undefined;
    }
    const autoRun = stage.autoRun ?? true;

    this.deps.events.emit("deployment.detected", {
      repository,
      stage,
      headSha,
      change,
      source,
      autoRun,
    });

    if (!autoRun) return undefined;
    return this.startRun({ stage, headSha, trigger: "push-webhook", triggeredBy: source, change });
  }

  /**
   * Context assembly failed for a deployment. Record a failed run and a
   * completed check so the failure is visible on GitHub, in the UI, and in
   * Slack. The cursor is left alone so the next push retries from the same
   * base.
   */
  private async recordFailedDeployment(
    repository: Repository,
    stage: Stage,
    headSha: string,
    source: string,
    err: unknown,
  ): Promise<Run> {
    const { store, github, events, runUrl } = this.deps;
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[runs] context assembly failed for ${repository.fullName}@${stage.branch} ${headSha.slice(0, 7)}:`, err);

    const now = new Date().toISOString();
    let run = await this.newRun(stage, repository, {
      status: "failed",
      trigger: "push-webhook",
      triggeredBy: source,
      change: {
        baseSha: stage.cursor?.sha ?? "",
        headSha,
        commitCount: 0,
        filesChanged: 0,
        pullRequests: [],
        compareStatus: "unavailable",
      },
      steps: [
        { id: randomUUID(), name: "Assemble context", status: "failed", startedAt: now, finishedAt: now, detail: reason },
      ],
      finishedAt: now,
    });

    try {
      const octokit = await github.getInstallationOctokit(repository.installationId);
      const checkRunId = await createFailedCheck(
        octokit,
        { owner: repository.owner, repo: repository.name },
        run,
        reason,
        runUrl(run),
      );
      run = await store.updateRun(run.id, { checkRunId });
    } catch (checkErr) {
      // Often the same root cause (revoked install); the run is still recorded.
      console.error(`[runs] failed to post failure check for ${run.id}:`, checkErr);
    }

    events.emit("deployment.failed", { repository, stage, headSha, reason, run });
    return run;
  }

  /** Persists a new run for a stage with empty fleet/coverage/findings. */
  private async newRun(
    stage: Stage,
    repository: Repository,
    fields: Pick<Run, "status" | "trigger" | "change"> & Partial<Run>,
  ): Promise<Run> {
    const run: Run = {
      id: randomUUID(),
      repositoryId: repository.id,
      stageId: stage.id,
      number: await this.deps.store.nextRunNumber(stage.id),
      verdict: "pending",
      steps: [],
      fleet: { ...EMPTY_FLEET, agentsRequested: stage.fleetSize },
      coverage: { ...EMPTY_COVERAGE },
      findings: { ...EMPTY_FINDINGS, bySeverity: { ...EMPTY_FINDINGS.bySeverity } },
      startedAt: new Date().toISOString(),
      ...fields,
    };
    await this.deps.store.createRun(run);
    return run;
  }

  /**
   * Repeat a finished run's change window at the same head SHA, e.g. from
   * GitHub's "Re-run" button. Re-runs never move the cursor, with one
   * exception: retrying a failed deployment whose base is still the cursor
   * finishes that deployment, so the cursor advances as a push would have.
   */
  async rerun(runId: string, triggeredBy: string): Promise<Run> {
    const original = await this.deps.store.getRun(runId);
    if (!original) throw new RunError(`Run ${runId} not found`, "run-not-found");
    if (isRunActive(original)) {
      throw new RunError(`Run ${runId} is still ${original.status}`, "run-not-active");
    }
    const stage = await this.deps.store.getStage(original.stageId);
    if (!stage) throw new RunError(`Stage ${original.stageId} not found`, "stage-not-found");
    const { baseSha, headSha } = original.change;
    // One in-flight run per stage head; a double-clicked "Re-run" is a no-op.
    const inFlight = (await this.deps.store.listRuns(stage.id)).find(
      (r) => isRunActive(r) && r.change.headSha === headSha,
    );
    if (inFlight) {
      throw new RunError(`Run #${inFlight.number} is already in progress for ${headSha.slice(0, 7)}`, "run-not-active");
    }
    const failedDeployment = original.change.compareStatus === "unavailable";
    return this.startRun({
      stage,
      headSha,
      trigger: "rerun",
      triggeredBy,
      // A failed deployment never got a diff; compute it from its original base.
      change: failedDeployment ? await this.computeChange(stage, headSha, baseSha) : original.change,
      rerunOf: original.id,
      keepCursor: !(failedDeployment && stage.cursor?.sha === baseSha),
    });
  }

  async startRun(input: StartRunInput): Promise<Run> {
    const { store, github, events, runUrl } = this.deps;
    // Re-read so we operate on the freshest cursor.
    const stage = (await store.getStage(input.stage.id)) ?? input.stage;
    const repository = await this.repoFor(stage);
    const change = input.change ?? (await this.computeChange(stage, input.headSha));

    if (!stage.cursor) {
      throw new RunError(`Stage ${stage.name} has no deploy cursor yet`, "no-cursor");
    }
    if (!input.keepCursor) {
      const lastPr = change.pullRequests.at(-1);
      const advanced = await store.advanceCursor(stage.id, stage.cursor.sha, {
        sha: input.headSha,
        prNumber: lastPr?.number,
        updatedAt: new Date().toISOString(),
      });
      if (!advanced) {
        throw new RunError(
          `Cursor for ${stage.name} moved while starting the run; retry`,
          "cursor-conflict",
        );
      }
    }

    const run = await this.newRun(stage, repository, {
      status: "queued",
      trigger: input.trigger,
      triggeredBy: input.triggeredBy,
      rerunOf: input.rerunOf,
      change,
    });

    let started = run;
    try {
      const octokit = await github.getInstallationOctokit(repository.installationId);
      const checkRunId = await createInProgressCheck(
        octokit,
        { owner: repository.owner, repo: repository.name },
        run,
        runUrl(run),
      );
      started = await store.updateRun(run.id, { checkRunId });
    } catch (err) {
      // The run exists and the cursor advanced; a missing check is recoverable.
      console.error(`[runs] failed to post check run for ${run.id}:`, err);
    }

    events.emit("run.started", { repository, stage, run: started });
    return started;
  }

  /** Loads a run that must still be in flight, with its stage and repository. */
  private async activeRun(runId: string): Promise<{ existing: Run; stage: Stage; repository: Repository }> {
    const existing = await this.deps.store.getRun(runId);
    if (!existing) throw new RunError(`Run ${runId} not found`, "run-not-found");
    if (!isRunActive(existing)) {
      throw new RunError(`Run ${runId} is already ${existing.status}`, "run-not-active");
    }
    const stage = await this.deps.store.getStage(existing.stageId);
    if (!stage) throw new RunError(`Stage ${existing.stageId} not found`, "stage-not-found");
    return { existing, stage, repository: await this.repoFor(stage) };
  }

  /**
   * Orchestrator reports progress on an active run: moves the status and
   * upserts one step card by name (started when first seen, finished when
   * `status` is terminal). Emits nothing; the UI polls.
   */
  async progress(
    runId: string,
    status: Extract<RunStatus, "assembling-context" | "exploring" | "triaging">,
    step: { name: string; status: RunStep["status"]; detail?: string },
  ): Promise<Run> {
    const { existing } = await this.activeRun(runId);
    const now = new Date().toISOString();
    const steps = [...existing.steps];
    const i = steps.findIndex((s) => s.name === step.name);
    const terminal = step.status === "succeeded" || step.status === "failed" || step.status === "skipped";
    if (i === -1) {
      steps.push({
        id: randomUUID(),
        name: step.name,
        status: step.status,
        startedAt: now,
        ...(terminal ? { finishedAt: now } : {}),
        ...(step.detail ? { detail: step.detail } : {}),
      });
    } else {
      const prev = steps[i] as RunStep;
      steps[i] = {
        ...prev,
        status: step.status,
        ...(terminal && !prev.finishedAt ? { finishedAt: now } : {}),
        ...(step.detail !== undefined ? { detail: step.detail } : {}),
      };
    }
    return this.deps.store.updateRun(runId, { status, steps });
  }

  /** Orchestrator / triage judge reports findings for a run still in flight. */
  async addFindings(runId: string, findings: Finding[]): Promise<Finding[]> {
    await this.activeRun(runId);
    await this.deps.store.saveFindings(runId, findings);
    return this.deps.store.listFindings(runId);
  }

  async completeRun(runId: string, result: CompleteRunInput): Promise<Run> {
    const { store, github, events, runUrl } = this.deps;
    const { stage, repository } = await this.activeRun(runId);

    const run = await store.updateRun(runId, {
      ...result,
      findings: result.findings ?? countFindings(await store.listFindings(runId)),
      status: result.verdict === "block" ? "blocked" : "passed",
      finishedAt: new Date().toISOString(),
    });

    if (run.checkRunId !== undefined) {
      try {
        const octokit = await github.getInstallationOctokit(repository.installationId);
        await completeCheck(octokit, { owner: repository.owner, repo: repository.name }, run, runUrl(run));
      } catch (err) {
        console.error(`[runs] failed to complete check run for ${run.id}:`, err);
      }
    }

    events.emit("run.finished", { repository, stage, run });
    return run;
  }

  /** Infra failure: no verdict, check goes to action_required. */
  async failRun(runId: string, reason: string): Promise<Run> {
    const { store, github, events } = this.deps;
    const { existing, stage, repository } = await this.activeRun(runId);

    const run = await store.updateRun(runId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      steps: [
        ...existing.steps,
        {
          id: randomUUID(),
          name: "failure",
          status: "failed",
          finishedAt: new Date().toISOString(),
          detail: reason,
        },
      ],
    });

    try {
      const octokit = await github.getInstallationOctokit(repository.installationId);
      await failCheck(octokit, { owner: repository.owner, repo: repository.name }, run, reason);
    } catch (err) {
      console.error(`[runs] failed to mark check run failed for ${run.id}:`, err);
    }

    events.emit("run.finished", { repository, stage, run });
    return run;
  }
}
