import type { AgentResult, ContextBundle, Persona, Repository, Run, Stage } from "@qa-agent/shared-types";
import type { EventBus } from "../events";
import { RunError, type RunService } from "../runs/service";
import { DiscoveryBoard } from "./discovery";
import { buildPersonas } from "./personas";
import { runWave, type AgentRunner } from "./runner";
import { triage } from "./triage";

export { InProcessAgentRunner, type AgentRunner } from "./runner";
export { triage, dedupeFindings } from "./triage";
export { buildPersonas, allocateDispositions } from "./personas";

export interface OrchestratorConfig {
  /** Agents in flight at once. Each is a Chromium instance. */
  concurrency: number;
  /** Fallback per-agent budget; `Stage.budgetSeconds` wins when set. */
  agentBudgetSeconds: number;
  /** Cap on stage.fleetSize for cost control; 0 = no cap. */
  maxFleetSize: number;
  /** Visits before a surface counts as saturated for later waves. */
  saturationThreshold: number;
  /**
   * URL-level boundaries (hosts, path prefixes) the browser blocks outright,
   * added to every bundle. Distinct from the manifest's `boundaries`, which
   * are policy sentences the agent reads.
   */
  blastRadiusBoundaries: string[];
}

export interface OrchestratorDeps {
  runs: RunService;
  events: EventBus;
  runner: AgentRunner;
  config: OrchestratorConfig;
  log?: (msg: string) => void;
}

const STEP_CONTEXT = "Assemble context";
const STEP_FLEET = "Fleet exploration";
const STEP_TRIAGE = "Triage & reproduce";

/**
 * Fleet orchestrator + triage judge. Listens for `run.started`, assembles a
 * ContextBundle per agent, runs the fleet in waves (steering later waves
 * away from saturated surfaces), then triages and completes the run. Any
 * infra failure ends in `failRun`, never a verdict.
 */
export class Orchestrator {
  private readonly inFlight = new Set<string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: OrchestratorDeps) {
    this.log = deps.log ?? ((m) => console.log(`[orchestrator] ${m}`));
  }

  /** Subscribe to the event bus; returns the unsubscribe function. */
  start(): () => void {
    return this.deps.events.on("run.started", async (e) => {
      await this.orchestrate(e.run, e.stage, e.repository);
    });
  }

  async orchestrate(run: Run, stage: Stage, repository: Repository): Promise<Run | undefined> {
    if (this.inFlight.has(run.id)) return undefined;
    this.inFlight.add(run.id);
    const { runs, config } = this.deps;
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
      const fleetSize = config.maxFleetSize > 0 ? Math.min(stage.fleetSize, config.maxFleetSize) : stage.fleetSize;
      if (fleetSize <= 0) throw new OrchestrationError(`Stage "${stage.name}" has fleetSize ${stage.fleetSize}`);
      const personas = buildPersonas(fleetSize, product);
      const touched = product.surfaces.filter((s) => s.touchedByChange).length;
      const budgetSeconds = stage.budgetSeconds ?? config.agentBudgetSeconds;

      await runs.progress(run.id, "assembling-context", {
        name: STEP_CONTEXT,
        status: "succeeded",
        detail: `${run.change.pullRequests.length} PRs, ${run.change.filesChanged} files; manifest ${product.manifestVersion}: ${product.surfaces.length} surfaces (${touched} touched), ${product.invariants.length} invariants; fleet ${fleetSize} x ${budgetSeconds}s`,
      });
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

      for (let start = 0; start < personas.length; start += config.concurrency) {
        const wave = personas.slice(start, start + config.concurrency).map((p, k) => bundleFor(p, start + k));
        this.log(`run ${run.id.slice(0, 8)}: wave ${Math.floor(start / config.concurrency) + 1}, ${wave.length} agents, ${wave[0]?.saturatedSurfaceIds.length ?? 0} saturated surfaces`);
        const waveResults = await runWave(
          wave,
          config.concurrency,
          (b) => this.deps.runner.run(b),
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
      const verdict = triage({ results, personas, product, change: run.change, agentsRequested: fleetSize });
      await runs.addFindings(run.id, verdict.findings);
      const canonical = verdict.findings.filter((f) => f.status !== "duplicate").length;
      await runs.progress(run.id, "triaging", {
        name: STEP_TRIAGE,
        status: "succeeded",
        detail: `${canonical} distinct findings from ${verdict.findings.length} reports`,
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
    } finally {
      this.inFlight.delete(run.id);
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
