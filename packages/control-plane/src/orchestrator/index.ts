import type { AgentResult, ContextBundle, FleetConfig, Persona, Repository, Run, Stage } from "@qa-agent/shared-types";
import type { EventBus } from "../events";
import { RunError, type RunService } from "../runs/service";
import { DiscoveryBoard } from "./discovery";
import { buildPersonas } from "./personas";
import { runWave, type AgentRunner } from "./runner";
import { triage } from "./triage";

export { InProcessAgentRunner, type AgentRunner, type AgentRunOverrides } from "./runner";
export { triage, dedupeFindings, type TriagePolicy } from "./triage";
export { buildPersonas, allocateDispositions, type DispositionMix } from "./personas";

export interface OrchestratorDeps {
  runs: RunService;
  events: EventBus;
  runner: AgentRunner;
  /**
   * The fleet configuration to use for the next run. Read once per run at
   * dequeue time so edits from the Fleet page apply without a restart.
   */
  fleet: () => Promise<FleetConfig>;
  /** Operator caps from the environment; the FleetConfig cannot exceed them. */
  caps?: {
    /** Hard cap on agents per run; 0 = no cap. */
    maxFleetSize?: number;
  };
  log?: (msg: string) => void;
}

const STEP_CONTEXT = "Assemble context";
const STEP_FLEET = "Fleet exploration";
const STEP_TRIAGE = "Triage & reproduce";

interface QueuedRun {
  run: Run;
  stage: Stage;
  repository: Repository;
}

/**
 * Fleet orchestrator + triage judge. Listens for `run.started`, queues the
 * run, and hands it to one of `fleet.orchestrators` workers. A worker
 * assembles a ContextBundle per agent, runs the fleet in waves (steering
 * later waves away from saturated surfaces), then triages and completes the
 * run. Any infra failure ends in `failRun`, never a verdict.
 */
export class Orchestrator {
  private readonly inFlight = new Set<string>();
  private readonly queue: QueuedRun[] = [];
  private pumping = false;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.log ?? ((m) => console.log(`[orchestrator] ${m}`));
  }

  /** Subscribe to the event bus; returns the unsubscribe function. */
  start(): () => void {
    return this.deps.events.on("run.started", (e) => {
      this.enqueue({ run: e.run, stage: e.stage, repository: e.repository });
    });
  }

  /** Runs being orchestrated and runs waiting for an orchestrator. */
  activity(): { active: number; queued: number } {
    return { active: this.inFlight.size, queued: this.queue.length };
  }

  /** Queue a run; it starts as soon as an orchestrator slot is free. */
  enqueue(item: QueuedRun): void {
    if (this.inFlight.has(item.run.id) || this.queue.some((q) => q.run.id === item.run.id)) return;
    this.queue.push(item);
    void this.pump();
  }

  /**
   * Start queued runs while slots are free. `orchestrators` is re-read each
   * time so lowering it takes effect as running work drains.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const config = await this.deps.fleet();
        if (this.inFlight.size >= Math.max(1, config.orchestrators)) break;
        const next = this.queue.shift() as QueuedRun;
        this.inFlight.add(next.run.id);
        if (this.queue.length) this.log(`run ${next.run.id.slice(0, 8)}: dequeued; ${this.queue.length} waiting, ${this.inFlight.size}/${config.orchestrators} orchestrators busy`);
        void this.execute(next, config).finally(() => {
          this.inFlight.delete(next.run.id);
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Orchestrate one run directly, bypassing the queue. Used by tests and manual triggers. */
  async orchestrate(run: Run, stage: Stage, repository: Repository): Promise<Run | undefined> {
    if (this.inFlight.has(run.id)) return undefined;
    this.inFlight.add(run.id);
    try {
      return await this.execute({ run, stage, repository }, await this.deps.fleet());
    } finally {
      this.inFlight.delete(run.id);
    }
  }

  private async execute({ run, stage, repository }: QueuedRun, config: FleetConfig): Promise<Run | undefined> {
    const { runs } = this.deps;
    const cap = this.deps.caps?.maxFleetSize ?? 0;
    try {
      await runs.progress(run.id, "assembling-context", { name: STEP_CONTEXT, status: "running" });

      if (!stage.environmentUrl) {
        throw new OrchestrationError(`Stage "${stage.name}" has no environmentUrl; set it via PUT /api/repositories/${repository.fullName}/stages/${stage.name}`);
      }
      // The run service owns context assembly: change window, the QA manifest
      // snapshot for this run (surfaces already marked touched), stage
      // environment and budget. We add the per-agent fields.
      const shared = await runs.contextFor(run.id);
      const product = shared.product;
      const requested = stage.fleetSize > 0 ? stage.fleetSize : config.agentsPerRun;
      const fleetSize = cap > 0 ? Math.min(requested, cap) : requested;
      if (fleetSize <= 0) throw new OrchestrationError(`Stage "${stage.name}" resolved to a fleet of ${fleetSize} agents`);
      const personas = buildPersonas(fleetSize, product, { focusPerAgent: config.focusPerAgent, mix: config.dispositionMix });
      const touched = product.surfaces.filter((s) => s.touchedByChange).length;
      const budgetSeconds = stage.budgetSeconds ?? config.agentBudgetSeconds;
      const overrides = {
        maxSteps: config.maxSteps,
        recordVideo: config.recordVideo,
        scrutiny: config.scrutiny,
        minSeverity: config.minSeverity,
        extraInstructions: config.teamInstructions,
        model: config.model,
      };

      await runs.progress(
        run.id,
        "assembling-context",
        {
          name: STEP_CONTEXT,
          status: "succeeded",
          detail: `${run.change.pullRequests.length} PRs, ${run.change.filesChanged} files; manifest ${product.manifestVersion}: ${product.surfaces.length} surfaces (${touched} touched), ${product.invariants.length} invariants; fleet ${fleetSize} x ${budgetSeconds}s, ${config.scrutiny} scrutiny${cap > 0 && requested > cap ? ` (capped from ${requested} by MAX_FLEET_SIZE)` : ""}`,
        },
        { fleet: { agentsRequested: fleetSize } },
      );
      await runs.progress(run.id, "exploring", { name: STEP_FLEET, status: "running", detail: `0/${fleetSize} agents done` });

      const board = new DiscoveryBoard(config.saturationThreshold);
      const results: AgentResult[] = [];
      const bundleFor = (persona: Persona, i: number): ContextBundle => ({
        ...shared,
        agentId: `${run.id.slice(0, 8)}-a${String(i + 1).padStart(3, "0")}`,
        persona,
        environment: {
          ...shared.environment,
          // The manifest's `boundaries` are policy sentences rendered from
          // product.boundaries; only URL rules belong here (the browser
          // blocks matching requests).
          blastRadiusBoundaries: config.blastRadiusBoundaries,
        },
        budgetSeconds,
        saturatedSurfaceIds: board.saturatedSurfaceIds(),
      });

      const concurrency = Math.max(1, config.concurrency);
      for (let start = 0; start < personas.length; start += concurrency) {
        const wave = personas.slice(start, start + concurrency).map((p, k) => bundleFor(p, start + k));
        this.log(`run ${run.id.slice(0, 8)}: wave ${Math.floor(start / concurrency) + 1}, ${wave.length} agents, ${wave[0]?.saturatedSurfaceIds.length ?? 0} saturated surfaces`);
        const waveResults = await runWave(
          wave,
          concurrency,
          (b) => this.deps.runner.run(b, overrides),
          (b, err) => failedResult(b, err),
        );
        for (const r of waveResults) {
          board.publish(r);
          results.push(r);
          if (r.videoPath) this.log(`run ${run.id.slice(0, 8)}: agent ${r.agentId} video ${r.videoPath}`);
        }
        // Stream findings so the UI fills in while the fleet is still running.
        const fresh = waveResults.flatMap((r) => r.findings);
        if (fresh.length) await runs.addFindings(run.id, fresh);
        await runs.progress(run.id, "exploring", {
          name: STEP_FLEET,
          status: "running",
          detail: `${results.length}/${fleetSize} agents done, ${results.reduce((n, r) => n + r.findings.length, 0)} raw findings`,
        });
      }

      const failed = results.filter((r) => r.status === "failed").length;
      await runs.progress(run.id, "exploring", {
        name: STEP_FLEET,
        status: failed === results.length ? "failed" : "succeeded",
        detail: `${results.length - failed}/${fleetSize} agents completed${failed ? `, ${failed} failed` : ""}, ${results.reduce((n, r) => n + r.trace.length, 0)} actions`,
      });
      if (failed === results.length) {
        throw new OrchestrationError(`All ${results.length} agents failed: ${results[0]?.error ?? "unknown error"}`);
      }

      await runs.progress(run.id, "triaging", { name: STEP_TRIAGE, status: "running" });
      const verdict = triage({
        results,
        personas,
        product,
        change: run.change,
        agentsRequested: fleetSize,
        policy: { minSeverity: config.minSeverity, blockOn: config.blockOn },
      });
      await runs.addFindings(run.id, verdict.findings);
      const canonical = verdict.findings.filter((f) => f.status !== "duplicate" && f.status !== "dismissed").length;
      const dismissed = verdict.findings.filter((f) => f.status === "dismissed").length;
      await runs.progress(run.id, "triaging", {
        name: STEP_TRIAGE,
        status: "succeeded",
        detail: `${canonical} distinct findings from ${verdict.findings.length} reports${dismissed ? `, ${dismissed} below the ${config.minSeverity} floor` : ""}; blocks on ${config.blockOn}+`,
      });

      const completed = await runs.completeRun(run.id, {
        verdict: verdict.verdict,
        confidenceStatement: verdict.confidenceStatement,
        confidenceScore: verdict.confidenceScore,
        coverage: verdict.coverage,
        fleet: verdict.fleet,
      });
      this.log(`run ${run.id.slice(0, 8)}: ${completed.verdict} (${completed.confidenceScore}) — ${completed.confidenceStatement}`);
      return completed;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log(`run ${run.id.slice(0, 8)} failed: ${reason}`);
      try {
        return await runs.failRun(run.id, reason);
      } catch (failErr) {
        // Already finished (e.g. cancelled while we ran); nothing more to do.
        if (!(failErr instanceof RunError)) console.error("[orchestrator] failRun error:", failErr);
        return undefined;
      }
    }
  }
}

export class OrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestrationError";
  }
}

function failedResult(bundle: ContextBundle, err: unknown): AgentResult {
  const now = new Date().toISOString();
  return {
    runId: bundle.runId,
    agentId: bundle.agentId,
    status: "failed",
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    findings: [],
    trace: [],
    visitedSurfaceIds: [],
    checkedInvariantIds: [],
    modelCalls: 0,
    startedAt: now,
    finishedAt: now,
  };
}
