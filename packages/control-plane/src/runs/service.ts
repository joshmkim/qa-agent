import { randomUUID } from "node:crypto";
import type {
  ChangeContext,
  CoverageSummary,
  FindingCounts,
  FleetSummary,
  GateVerdict,
  Repository,
  Run,
  Stage,
} from "@qa-agent/shared-types";
import type { EventBus } from "../events";
import type { GitHubApp } from "../github/app";
import { completeCheck, createInProgressCheck, failCheck } from "../github/checks";
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
}

export interface CompleteRunInput {
  verdict: Exclude<GateVerdict, "pending">;
  confidenceStatement?: string;
  confidenceScore?: number;
  findings: FindingCounts;
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

const ACTIVE_STATUSES: ReadonlySet<Run["status"]> = new Set([
  "queued",
  "assembling-context",
  "exploring",
  "triaging",
]);

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

  async computeChange(stage: Stage, headSha: string): Promise<ChangeContext> {
    if (!stage.cursor) {
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
      stage.cursor.sha,
      headSha,
    );
  }

  /**
   * A new head landed on a stage branch. Announces it, and starts a run when
   * the stage is configured to auto-run. Returns the run if one started.
   */
  async detectDeployment(stage: Stage, headSha: string, source: string): Promise<Run | undefined> {
    const repository = await this.repoFor(stage);
    const change = await this.computeChange(stage, headSha);
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

  async startRun(input: StartRunInput): Promise<Run> {
    const { store, github, events, runUrl } = this.deps;
    // Re-read so we operate on the freshest cursor.
    const stage = (await store.getStage(input.stage.id)) ?? input.stage;
    const repository = await this.repoFor(stage);
    const change = input.change ?? (await this.computeChange(stage, input.headSha));

    if (!stage.cursor) {
      throw new RunError(`Stage ${stage.name} has no deploy cursor yet`, "no-cursor");
    }
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

    const run: Run = {
      id: randomUUID(),
      repositoryId: repository.id,
      stageId: stage.id,
      number: await store.nextRunNumber(stage.id),
      status: "queued",
      verdict: "pending",
      trigger: input.trigger,
      triggeredBy: input.triggeredBy,
      change,
      steps: [],
      fleet: { ...EMPTY_FLEET, agentsRequested: stage.fleetSize },
      coverage: { ...EMPTY_COVERAGE },
      findings: { ...EMPTY_FINDINGS, bySeverity: { ...EMPTY_FINDINGS.bySeverity } },
      startedAt: new Date().toISOString(),
    };
    await store.createRun(run);

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

  async completeRun(runId: string, result: CompleteRunInput): Promise<Run> {
    const { store, github, events, runUrl } = this.deps;
    const existing = await store.getRun(runId);
    if (!existing) throw new RunError(`Run ${runId} not found`, "run-not-found");
    if (!ACTIVE_STATUSES.has(existing.status)) {
      throw new RunError(`Run ${runId} is already ${existing.status}`, "run-not-active");
    }
    const stage = await store.getStage(existing.stageId);
    if (!stage) throw new RunError(`Stage ${existing.stageId} not found`, "stage-not-found");
    const repository = await this.repoFor(stage);

    const run = await store.updateRun(runId, {
      ...result,
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
    const existing = await store.getRun(runId);
    if (!existing) throw new RunError(`Run ${runId} not found`, "run-not-found");
    if (!ACTIVE_STATUSES.has(existing.status)) {
      throw new RunError(`Run ${runId} is already ${existing.status}`, "run-not-active");
    }
    const stage = await store.getStage(existing.stageId);
    if (!stage) throw new RunError(`Stage ${existing.stageId} not found`, "stage-not-found");
    const repository = await this.repoFor(stage);

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
