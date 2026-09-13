import { randomUUID } from "node:crypto";
import {
  isRunActive,
  type ManifestSnapshot,
  type ProductContext,
  type RunContext,
  type RunStep,
  type ChangeContext,
  type CoverageSummary,
  type Finding,
  type FindingCounts,
  type FleetSummary,
  type GateVerdict,
  type Repository,
  type Run,
  type Stage,
} from "@qa-agent/shared-types";
import type { EventBus } from "../events";
import type { GitHubApp } from "../github/app";
import { completeCheck, createFailedCheck, createInProgressCheck, failCheck } from "../github/checks";
import { computeChangeContext } from "../github/diff";
import { DEFAULT_MANIFEST_PATH, loadManifest, markTouched } from "../manifest/load";
import type { Store } from "../store";

export interface RunServiceDeps {
  store: Store;
  github: GitHubApp;
  events: EventBus;
  /** Builds the human-facing URL for a run (web UI), used in check runs and Slack. */
  runUrl: (run: Run) => string;
  /** Jira project prefixes to recognise in PRs and commits; empty disables scanning. */
  jiraProjectKeys?: string[];
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

/** Per-agent wall-clock budget when the stage doesn't set one. */
const DEFAULT_BUDGET_SECONDS = 45 * 60;
const MAX_TOUCHED_LISTED = 15;

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
 * Gate counts exclude duplicates and dismissed findings; every duplicate the
 * triage judge folded into a finding counts as collapsed.
 */
export function countFindings(findings: Finding[]): FindingCounts {
  const counts: FindingCounts = { bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 }, total: 0, duplicatesCollapsed: 0 };
  for (const f of findings) {
    if (f.status === "duplicate") {
      counts.duplicatesCollapsed += 1;
      continue;
    }
    if (f.status === "dismissed") continue;
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
      this.deps.jiraProjectKeys,
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

    const startedAt = new Date().toISOString();
    const snapshot = await this.manifestAt(repository, input.headSha);
    const product = snapshot.product && markTouched(snapshot.product, change);
    const touched = product?.surfaces.filter((s) => s.touchedByChange) ?? [];

    const run = await this.newRun(stage, repository, {
      status: "queued",
      trigger: input.trigger,
      triggeredBy: input.triggeredBy,
      rerunOf: input.rerunOf,
      change,
      startedAt,
      manifest: {
        path: snapshot.path,
        commitSha: snapshot.commitSha,
        status: snapshot.status,
        errors: snapshot.errors,
        loadedAt: snapshot.loadedAt,
        version: product?.manifestVersion,
      },
      steps: [manifestStep(snapshot, product, change.filesTruncated === true, startedAt)],
      coverage: {
        surfacesTotal: product?.surfaces.length ?? 0,
        surfacesVisited: 0,
        changedSurfacesTotal: touched.length,
        changedSurfacesVisited: 0,
        invariantsTotal: product?.invariants.length ?? 0,
        invariantsChecked: 0,
      },
    });

    let started = run;
    try {
      const octokit = await github.getInstallationOctokit(repository.installationId);
      const checkRunId = await createInProgressCheck(
        octokit,
        { owner: repository.owner, repo: repository.name },
        run,
        runUrl(run),
        manifestSummary(snapshot, product),
      );
      started = await store.updateRun(run.id, { checkRunId });
    } catch (err) {
      // The run exists and the cursor advanced; a missing check is recoverable.
      console.error(`[runs] failed to post check run for ${run.id}:`, err);
    }

    events.emit("run.started", { repository, stage, run: started });
    return started;
  }

  /**
   * The QA manifest at a commit, cached per commit so re-runs don't refetch.
   * Fetch errors are returned (and not cached) so a transient failure is
   * retried by the next run; it never blocks the run itself.
   */
  async manifestAt(repository: Repository, commitSha: string): Promise<ManifestSnapshot> {
    const cached = await this.deps.store.getManifestSnapshot(repository.id, commitSha);
    if (cached && cached.status !== "error") return cached;
    let snapshot: ManifestSnapshot;
    try {
      const octokit = await this.deps.github.getInstallationOctokit(repository.installationId);
      snapshot = await loadManifest(octokit, { owner: repository.owner, repo: repository.name }, commitSha);
    } catch (err) {
      snapshot = {
        path: DEFAULT_MANIFEST_PATH,
        commitSha,
        status: "error",
        errors: [(err as Error).message],
        loadedAt: new Date().toISOString(),
      };
    }
    await this.deps.store.saveManifestSnapshot(repository.id, snapshot);
    return snapshot;
  }

  /** The manifest a run used, with surfaces marked touched by that run's change. */
  async runManifest(runId: string): Promise<ManifestSnapshot | undefined> {
    const run = await this.deps.store.getRun(runId);
    if (!run) throw new RunError(`Run ${runId} not found`, "run-not-found");
    if (!run.manifest) return undefined;
    const snapshot = await this.deps.store.getManifestSnapshot(run.repositoryId, run.manifest.commitSha);
    if (!snapshot) return undefined;
    return snapshot.product ? { ...snapshot, product: markTouched(snapshot.product, run.change) } : snapshot;
  }

  /**
   * The pipeline's current manifest: the latest snapshot (touched flags from
   * the newest run that used it), or loaded from the default branch head if
   * no run has loaded one yet.
   */
  async pipelineManifest(repository: Repository): Promise<ManifestSnapshot> {
    const latest = await this.deps.store.getLatestManifestSnapshot(repository.id);
    if (latest) {
      const run = (await this.deps.store.listRunsByRepository(repository.id)).find(
        (r) => r.manifest?.commitSha === latest.commitSha,
      );
      return run && latest.product ? { ...latest, product: markTouched(latest.product, run.change) } : latest;
    }
    try {
      const octokit = await this.deps.github.getInstallationOctokit(repository.installationId);
      const { data } = await octokit.rest.repos.getBranch({
        owner: repository.owner,
        repo: repository.name,
        branch: repository.defaultBranch,
      });
      return await this.manifestAt(repository, data.commit.sha);
    } catch (err) {
      return {
        path: DEFAULT_MANIFEST_PATH,
        commitSha: "",
        status: "error",
        errors: [(err as Error).message],
        loadedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Everything every agent in a run shares: the change under test, product
   * knowledge from the manifest, and the stage's environment. The
   * orchestrator adds agentId, persona and saturated surfaces per agent.
   */
  async contextFor(runId: string): Promise<RunContext> {
    const run = await this.deps.store.getRun(runId);
    if (!run) throw new RunError(`Run ${runId} not found`, "run-not-found");
    const stage = await this.deps.store.getStage(run.stageId);
    if (!stage) throw new RunError(`Stage ${run.stageId} not found`, "stage-not-found");
    const repository = await this.repoFor(stage);
    const manifest = await this.runManifest(runId);
    const product: ProductContext = manifest?.product ?? {
      productName: repository.name,
      intent: "",
      stakeholders: [],
      surfaces: [],
      invariants: [],
      manifestVersion: "none",
      boundaries: [],
    };
    return {
      runId: run.id,
      change: run.change,
      product,
      environment: {
        stageName: stage.name,
        baseUrl: stage.environmentUrl ?? "",
        credentialsRef: stage.credentialsRef ?? "",
        blastRadiusBoundaries: product.boundaries ?? [],
      },
      budgetSeconds: stage.budgetSeconds ?? DEFAULT_BUDGET_SECONDS,
    };
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
        const snapshot = run.manifest && (await store.getManifestSnapshot(repository.id, run.manifest.commitSha));
        const product = snapshot?.product && markTouched(snapshot.product, run.change);
        await completeCheck(
          octokit,
          { owner: repository.owner, repo: repository.name },
          run,
          runUrl(run),
          snapshot ? manifestSummary(snapshot, product) : [],
        );
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

/** The "Load QA manifest" step recorded on every run. */
function manifestStep(
  snapshot: ManifestSnapshot,
  product: ProductContext | undefined,
  filesTruncated: boolean,
  at: string,
): RunStep {
  const base = { id: randomUUID(), name: "Load QA manifest", startedAt: at, finishedAt: at };
  const short = snapshot.commitSha.slice(0, 7);
  switch (snapshot.status) {
    case "loaded": {
      const touched = product?.surfaces.filter((s) => s.touchedByChange).length ?? 0;
      return {
        ...base,
        status: "succeeded",
        detail:
          `${snapshot.path} @ ${product?.manifestVersion}: ${product?.surfaces.length} surfaces (${touched} touched), ` +
          `${product?.invariants.length} invariants` +
          (filesTruncated ? "; file list truncated, so every mapped surface counts as touched" : ""),
      };
    }
    case "missing":
      return { ...base, status: "skipped", detail: `No ${snapshot.path} at ${short}; agents run without product context` };
    case "invalid":
      return {
        ...base,
        status: "failed",
        detail: `${snapshot.path} at ${short} is invalid (${snapshot.errors?.length ?? 0} error(s)): ${snapshot.errors?.join("; ")}`,
      };
    case "error":
      return { ...base, status: "failed", detail: `Could not read ${snapshot.path} at ${short}: ${snapshot.errors?.join("; ")}` };
  }
}

/** Markdown lines for the GitHub check summary. */
function manifestSummary(snapshot: ManifestSnapshot, product: ProductContext | undefined): string[] {
  const lines = ["", "### QA manifest"];
  if (snapshot.status !== "loaded" || !product) {
    const why =
      snapshot.status === "missing"
        ? `No \`${snapshot.path}\` in this commit; agents run without surfaces or invariants.`
        : `\`${snapshot.path}\` could not be used (${snapshot.status}):\n` +
          (snapshot.errors ?? []).map((e) => `- ${e}`).join("\n");
    lines.push(why);
    return lines;
  }
  const touched = product.surfaces.filter((s) => s.touchedByChange);
  lines.push(
    `\`${snapshot.path}\` @ \`${product.manifestVersion}\`: ${product.surfaces.length} surfaces, ${product.invariants.length} invariants`,
  );
  if (touched.length === 0) {
    lines.push("", "_No mapped surfaces touched by this change._");
  } else {
    lines.push("", `**Surfaces touched by this change (${touched.length})**`);
    for (const s of touched.slice(0, MAX_TOUCHED_LISTED)) lines.push(`- ${s.name} (\`${s.locator}\`)`);
    if (touched.length > MAX_TOUCHED_LISTED) lines.push(`- _…and ${touched.length - MAX_TOUCHED_LISTED} more_`);
  }
  return lines;
}
