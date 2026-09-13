/**
 * Offline smoke test for the orchestrator: real RunService + MemoryStore +
 * EventBus, a GitHub stub (check-run failures are tolerated by the service),
 * and a scripted AgentRunner. No browser, no model, no network.
 *
 *   pnpm --filter @qa-agent/control-plane orchestrator-smoke
 */
import type { AgentResult, ContextBundle, Finding, ProductContext, Repository, Run, Stage } from "@qa-agent/shared-types";
import { EventBus } from "../src/events";
import type { GitHubApp } from "../src/github/app";
import { Orchestrator, type AgentRunner } from "../src/orchestrator";
import { RunService } from "../src/runs/service";
import { MemoryStore } from "../src/store/memory";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${msg}`);
  }
}

const github = { getInstallationOctokit: async () => { throw new Error("no GitHub in smoke"); } } as unknown as GitHubApp;

const product: ProductContext = {
  productName: "Storefront",
  intent: "Sell things",
  stakeholders: ["Commerce"],
  manifestVersion: "3",
  // `sources` globs drive touchedByChange via the run service's markTouched;
  // the change below touches web/cart/** so cart and checkout light up.
  surfaces: [
    { id: "s_home", kind: "page", name: "Home", locator: "/", sources: ["web/home/**"] },
    { id: "s_cart", kind: "page", name: "Cart", locator: "/cart", sources: ["web/cart/**"] },
    { id: "s_checkout", kind: "flow", name: "Checkout", locator: "/checkout", sources: ["web/cart/**", "web/checkout/**"] },
    { id: "s_account", kind: "page", name: "Account", locator: "/account", sources: ["web/account/**"] },
  ],
  invariants: [
    { id: "inv_total", statement: "Cart total = items + tax", severityOnViolation: "P0" },
    { id: "inv_stock", statement: "Cannot buy out-of-stock items", severityOnViolation: "P1" },
  ],
  boundaries: ["Never call the database directly."],
};

function finding(b: ContextBundle, over: Partial<Finding>): Finding {
  return {
    id: `fnd_${Math.random().toString(36).slice(2, 8)}`,
    runId: b.runId,
    agentId: b.agentId,
    personaName: b.persona.name,
    severity: "P2",
    title: "x",
    summary: "y",
    surfaceId: "s_cart",
    oracle: "llm-judgment",
    dedupeKey: "k",
    reproSteps: [{ index: 0, kind: "navigate", description: "go", args: {}, outcome: "ok", durationMs: 1 }],
    evidence: [],
    status: "new",
    reportedAt: new Date().toISOString(),
    ...over,
  };
}

/** Agent i behaviour is scripted by index; records the bundles it saw. */
class ScriptedRunner implements AgentRunner {
  bundles: ContextBundle[] = [];
  constructor(private readonly script: (i: number, b: ContextBundle) => AgentResult | Error) {}
  async run(b: ContextBundle): Promise<AgentResult> {
    this.bundles.push(b);
    const out = this.script(this.bundles.length - 1, b);
    if (out instanceof Error) throw out;
    return out;
  }
}

function result(b: ContextBundle, over: Partial<AgentResult>): AgentResult {
  const now = new Date().toISOString();
  return {
    runId: b.runId,
    agentId: b.agentId,
    status: "completed",
    findings: [],
    trace: Array.from({ length: 10 }, (_, i) => ({ index: i, kind: "click" as const, description: "c", args: {}, outcome: "ok" as const, durationMs: 5 })),
    visitedSurfaceIds: [],
    checkedInvariantIds: [],
    modelCalls: 10,
    startedAt: now,
    finishedAt: now,
    ...over,
  };
}

async function setup(fleetSize: number) {
  const store = new MemoryStore();
  const events = new EventBus();
  const runs = new RunService({ store, github, events, runUrl: (r) => `http://web/${r.id}` });
  const repository: Repository = { id: "repo_1", owner: "o", name: "r", fullName: "o/r", defaultBranch: "main", installationId: 1, url: "" };
  const stage: Stage = {
    id: "stage_beta", repositoryId: "repo_1", name: "beta", branch: "beta", order: 0,
    environmentUrl: "http://beta.local", cursor: { sha: "base000", updatedAt: new Date().toISOString() },
    gatesPromotion: true, fleetSize, budgetSeconds: 60,
  };
  await store.upsertRepository(repository);
  await store.upsertStage(stage);
  // Pre-seed the manifest snapshot for the head commit so startRun's
  // manifestAt() hits the cache instead of GitHub.
  await store.saveManifestSnapshot(repository.id, {
    path: ".qa/manifest.yaml",
    commitSha: "head111",
    status: "loaded",
    product,
    loadedAt: new Date().toISOString(),
  });
  const finished = new Promise<Run>((resolve) => events.on("run.finished", (e) => resolve(e.run)));
  const change: Run["change"] = {
    baseSha: "base000", headSha: "head111", commitCount: 1, filesChanged: 2, compareStatus: "ahead",
    pullRequests: [
      { number: 7, title: "Rework cart totals", body: "Cart page total math", author: "a", labels: [], linkedIssues: [], url: "", mergedAt: "2026-09-12T00:00:00Z", filesChanged: 1, additions: 1, deletions: 1 },
      { number: 8, title: "Account avatar", body: "", author: "b", labels: [], linkedIssues: [], url: "", mergedAt: "2026-09-12T01:00:00Z", filesChanged: 1, additions: 1, deletions: 1 },
    ],
    changedFiles: [{ path: "web/cart/total.ts", status: "modified", additions: 1, deletions: 1 }],
  };
  return { store, events, runs, repository, stage, finished, change };
}

async function scenarioBlocked() {
  console.log("\n# scenario: P0 found by two agents, one agent fails");
  const { store, events, runs, stage, finished, change } = await setup(5);
  const runner = new ScriptedRunner((i, b) => {
    if (i === 0 || i === 1) {
      // Same bug, agent 1 has the shorter repro.
      return result(b, {
        findings: [finding(b, { severity: "P0", title: "Cart total wrong", surfaceId: "s_cart", oracle: "invariant", invariantId: "inv_total", dedupeKey: "dup-total",
          reproSteps: Array.from({ length: i === 0 ? 6 : 3 }, (_, k) => ({ index: k, kind: "click" as const, description: "c", args: {}, outcome: "ok" as const, durationMs: 1 })) })],
        visitedSurfaceIds: ["s_cart", "s_home"],
        checkedInvariantIds: ["inv_total"],
      });
    }
    if (i === 2) return result(b, { findings: [finding(b, { severity: "P2", title: "Avatar blurry", surfaceId: "s_account", dedupeKey: "avatar" })], visitedSurfaceIds: ["s_account", "s_cart"] });
    if (i === 3) return new Error("browser exploded");
    return result(b, { visitedSurfaceIds: ["s_cart"], checkedInvariantIds: ["inv_stock"] });
  });
  new Orchestrator({ runs, events, runner, log: (m) => console.log(`   ${m}`), config: { concurrency: 2, agentBudgetSeconds: 60, maxFleetSize: 0, saturationThreshold: 2, blastRadiusBoundaries: ["/admin"] } }).start();

  const started = await runs.startRun({ stage, headSha: "head111", trigger: "api", change });
  const run = await finished;
  const findings = await store.listFindings(run.id);
  const canonical = findings.filter((f) => f.status !== "duplicate");
  const dup = findings.find((f) => f.status === "duplicate");
  const p0 = canonical.find((f) => f.severity === "P0");

  assert(run.id === started.id && run.status === "blocked" && run.verdict === "block", `run blocked (status=${run.status}, verdict=${run.verdict})`);
  assert(runner.bundles.length === 5, `5 agents dispatched (${runner.bundles.length})`);
  assert(runner.bundles[0]?.saturatedSurfaceIds.length === 0 && (runner.bundles[2]?.saturatedSurfaceIds ?? []).includes("s_home"), `wave 2 sees s_home saturated (wave2: ${runner.bundles[2]?.saturatedSurfaceIds.join(",")})`);
  assert(!(runner.bundles[2]?.saturatedSurfaceIds ?? []).includes("s_cart"), "wave 2: s_cart (1 quiet visit) not yet saturated");
  assert(!(runner.bundles[4]?.saturatedSurfaceIds ?? []).includes("s_account"), `wave 3: surface with a fresh finding stays open (wave3: ${runner.bundles[4]?.saturatedSurfaceIds.join(",")})`);
  assert(
    runner.bundles.every(
      (b) =>
        b.environment.baseUrl === "http://beta.local" &&
        b.environment.blastRadiusBoundaries.join() === "/admin" &&
        b.product.surfaces.length === 4 &&
        b.product.boundaries?.[0] === "Never call the database directly." &&
        b.budgetSeconds === 60,
    ),
    "bundles carry env (URL boundaries only), code primitives product with policy boundaries, and budget",
  );
  assert(
    runner.bundles[0]?.product.surfaces.filter((s) => s.touchedByChange).map((s) => s.id).join() === "s_cart,s_checkout",
    `touched surfaces come from code primitives sources globs (${runner.bundles[0]?.product.surfaces.filter((s) => s.touchedByChange).map((s) => s.id).join()})`,
  );
  assert(new Set(runner.bundles.map((b) => b.persona.disposition)).size >= 3, `dispositions mixed: ${runner.bundles.map((b) => b.persona.disposition).join(",")}`);
  assert(runner.bundles.every((b) => b.persona.focusAreas.some((id) => id === "s_cart" || id === "s_checkout")), "every persona focuses on a touched surface");
  assert(findings.length === 3 && canonical.length === 2 && dup?.triage?.duplicateOf === p0?.id, `3 stored, 2 canonical, dup points at canonical`);
  assert(p0?.reproSteps.length === 3 && p0.status === "reproduced" && p0.triage?.reproducedFromCleanSession === true && p0.triage.duplicateCount === 1, "canonical P0 = shortest repro, marked reproduced");
  assert(p0?.triage?.suspectedPrNumber === 7, `P0 attributed to PR #7 (got ${p0?.triage?.suspectedPrNumber})`);
  assert(run.findings.total === 2 && run.findings.bySeverity.P0 === 1 && run.findings.bySeverity.P2 === 1 && run.findings.duplicatesCollapsed === 1, `counts ${JSON.stringify(run.findings)}`);
  assert(run.fleet.agentsRequested === 5 && run.fleet.agentsCompleted === 4 && run.fleet.agentsFailed === 1 && run.fleet.totalActions === 40, `fleet ${JSON.stringify(run.fleet)}`);
  assert(run.coverage.surfacesTotal === 4 && run.coverage.surfacesVisited === 3 && run.coverage.changedSurfacesTotal === 2 && run.coverage.changedSurfacesVisited === 1 && run.coverage.invariantsChecked === 2, `coverage ${JSON.stringify(run.coverage)}`);
  assert(run.steps.length === 4 && run.steps[0]?.name === "Load code primitives" && run.steps.every((s) => s.status === "succeeded" && s.finishedAt), `steps: ${run.steps.map((s) => `${s.name}=${s.status}`).join(", ")}`);
  assert(/^Low confidence/.test(run.confidenceStatement ?? "") && /Gap: Checkout/.test(run.confidenceStatement ?? "") && /suspected #7/.test(run.confidenceStatement ?? ""), `statement: ${run.confidenceStatement}`);
  assert((run.confidenceScore ?? 1) < 0.35, `confidence ${run.confidenceScore}`);
}

async function scenarioPass() {
  console.log("\n# scenario: clean run");
  const { runs, events, stage, finished, change } = await setup(3);
  const runner = new ScriptedRunner((_i, b) => result(b, { visitedSurfaceIds: ["s_cart", "s_checkout", "s_home", "s_account"], checkedInvariantIds: ["inv_total", "inv_stock"] }));
  new Orchestrator({ runs, events, runner, log: () => undefined, config: { concurrency: 4, agentBudgetSeconds: 60, maxFleetSize: 2, saturationThreshold: 2, blastRadiusBoundaries: [] } }).start();
  await runs.startRun({ stage, headSha: "head111", trigger: "api", change });
  const run = await finished;
  assert(run.status === "passed" && run.verdict === "pass", `run passed (${run.status}/${run.verdict})`);
  assert(runner.bundles.length === 2 && run.fleet.agentsRequested === 2, `fleet capped to 2 (${runner.bundles.length})`);
  assert(/^High confidence/.test(run.confidenceStatement ?? "") && /2 of 2 changed surfaces \(100%\)/.test(run.confidenceStatement ?? ""), `statement: ${run.confidenceStatement}`);
  assert((run.confidenceScore ?? 0) > 0.9, `confidence ${run.confidenceScore}`);
}

async function scenarioNoEnv() {
  console.log("\n# scenario: stage without environmentUrl");
  const { runs, events, stage, finished, change, store } = await setup(2);
  await store.upsertStage({ ...stage, environmentUrl: undefined });
  const runner = new ScriptedRunner((_i, b) => result(b, {}));
  new Orchestrator({ runs, events, runner, log: () => undefined, config: { concurrency: 1, agentBudgetSeconds: 60, maxFleetSize: 0, saturationThreshold: 2, blastRadiusBoundaries: [] } }).start();
  await runs.startRun({ stage: { ...stage, environmentUrl: undefined }, headSha: "head111", trigger: "api", change });
  const run = await finished;
  assert(run.status === "failed" && run.verdict === "pending", `run failed without verdict (${run.status}/${run.verdict})`);
  assert(runner.bundles.length === 0, "no agents dispatched");
  assert(run.steps.some((s) => s.name === "failure" && /environmentUrl/.test(s.detail ?? "")), `failure step explains: ${run.steps.at(-1)?.detail}`);
}

async function main() {
  await scenarioBlocked();
  await scenarioPass();
  await scenarioNoEnv();
  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
