/**
 * Behavioral contract for Store implementations. MemoryStore is the reference;
 * PostgresStore must match it. The Postgres half runs when TEST_DATABASE_URL
 * is set (e.g. postgres://qa:qa@localhost:5433/qa_agent_test from `pnpm db:up`).
 *
 *   TEST_DATABASE_URL=... pnpm --filter @qa-agent/control-plane test
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import postgres, { type Sql } from "postgres";
import type { Finding, ManifestSnapshot, Repository, Run, Stage } from "@qa-agent/shared-types";
import type { Installation, Store } from "./index";
import { MemoryStore } from "./memory";
import { migrate } from "./migrate";
import { PostgresStore } from "./postgres";

interface Harness {
  store: Store;
  /** Make a claimed delivery look older than the 24h dedupe window. */
  backdateDelivery: (id: string) => Promise<void>;
}

// --- fixtures -------------------------------------------------------------

const installation = (id = 1, over: Partial<Installation> = {}): Installation => ({
  installationId: id,
  accountLogin: "acme",
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
  installedAt: "2026-09-13T10:00:00.000Z",
  ...over,
});

const repository = (id = "r1", over: Partial<Repository> = {}): Repository => ({
  id,
  owner: "Acme",
  name: `repo-${id}`,
  fullName: `Acme/repo-${id}`,
  defaultBranch: "main",
  installationId: 1,
  url: `https://github.com/Acme/repo-${id}`,
  ...over,
});

const stage = (id = "s1", over: Partial<Stage> = {}): Stage => ({
  id,
  repositoryId: "r1",
  name: id,
  branch: id,
  order: 1,
  gatesPromotion: true,
  fleetSize: 10,
  ...over,
});

const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  repositoryId: "r1",
  stageId: "s1",
  number: 1,
  status: "queued",
  verdict: "pending",
  trigger: "push-webhook",
  change: {
    baseSha: "aaa",
    headSha: "bbb",
    commitCount: 1,
    filesChanged: 1,
    pullRequests: [],
    compareStatus: "ahead",
    changedFiles: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
    filesTruncated: false,
  },
  steps: [],
  fleet: { agentsRequested: 10, agentsCompleted: 0, agentsFailed: 0, dispositions: {}, totalActions: 0 },
  coverage: {
    surfacesTotal: 0,
    surfacesVisited: 0,
    changedSurfacesTotal: 0,
    changedSurfacesVisited: 0,
    invariantsTotal: 0,
    invariantsChecked: 0,
  },
  findings: { bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 }, total: 0, duplicatesCollapsed: 0 },
  startedAt: "2026-09-13T12:00:00.000Z",
  ...over,
});

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  runId: "run1",
  agentId: "agent_1",
  personaName: "Impatient shopper",
  severity: "P2",
  title: `Finding ${id}`,
  summary: "Something broke",
  surfaceId: "checkout",
  oracle: "hard-error",
  dedupeKey: `checkout:${id}`,
  reproSteps: [{ index: 1, kind: "click", description: "Click pay", args: { selector: "#pay" }, outcome: "failed", durationMs: 120 }],
  evidence: [{ id: "ev1", kind: "log", label: "log", content: "500", capturedAt: "2026-09-13T12:01:00.000Z" }],
  status: "new",
  reportedAt: "2026-09-13T12:01:00.000Z",
  ...over,
});

const snapshot = (commitSha: string, loadedAt: string, over: Partial<ManifestSnapshot> = {}): ManifestSnapshot => ({
  path: ".qa/manifest.yaml",
  commitSha,
  status: "invalid",
  errors: ['invariants[0].surfaces[0]: unknown surface "chekout"'],
  loadedAt,
  ...over,
});

/** Installation r1/s1 exist, the common starting point. */
async function seedBasics(store: Store): Promise<void> {
  await store.upsertInstallation(installation());
  await store.upsertRepository(repository());
  await store.upsertStage(stage("s1", { cursor: { sha: "base", updatedAt: "2026-09-13T11:00:00.000Z" } }));
}

// --- contract -------------------------------------------------------------

function describeStore(name: string, setup: () => Promise<Harness>) {
  describe(`${name} store contract`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await setup();
    });

    it("round-trips installations and repositories", async () => {
      const inst = installation(1);
      await h.store.upsertInstallation(inst);
      assert.deepEqual(await h.store.getInstallation(1), inst);
      await h.store.upsertInstallation({ ...inst, suspended: true });
      assert.equal((await h.store.getInstallation(1))?.suspended, true);
      assert.equal((await h.store.listInstallations()).length, 1);

      const repo = repository("r1");
      await h.store.upsertRepository(repo);
      await h.store.upsertRepository(repository("r2", { installationId: 1 }));
      assert.deepEqual(await h.store.getRepository("r1"), repo);
      assert.deepEqual(await h.store.getRepositoryByFullName("acme/REPO-r1"), repo, "full name lookup is case-insensitive");
      assert.equal((await h.store.listRepositories(1)).length, 2);
      assert.equal((await h.store.listRepositories(99)).length, 0);
      assert.equal(await h.store.getRepository("missing"), undefined);
    });

    it("stores repositories whose installation was never recorded", async () => {
      // Push webhooks and installation sync can arrive without installation.created.
      await h.store.upsertRepository(repository("r9", { installationId: 555 }));
      assert.equal((await h.store.listRepositories(555)).length, 1);
      await h.store.deleteInstallation(555);
      assert.equal(await h.store.getRepository("r9"), undefined);
    });

    it("deleting an installation removes its repositories but keeps stages and runs", async () => {
      await seedBasics(h.store);
      await h.store.createRun(run("run1"));
      await h.store.deleteInstallation(1);
      assert.equal(await h.store.getInstallation(1), undefined);
      assert.equal(await h.store.getRepository("r1"), undefined);
      assert.ok(await h.store.getStage("s1"));
      assert.ok(await h.store.getRun("run1"));
    });

    it("round-trips stages, orders them, and finds by branch", async () => {
      await seedBasics(h.store);
      await h.store.upsertStage(stage("s0", { order: 0, branch: "alpha", credentialsRef: "vault://x", budgetSeconds: 900 }));
      assert.deepEqual(
        (await h.store.listStages("r1")).map((s) => s.id),
        ["s0", "s1"],
      );
      assert.equal((await h.store.findStageByBranch("r1", "alpha"))?.id, "s0");
      assert.equal(await h.store.findStageByBranch("r1", "nope"), undefined);
      assert.equal((await h.store.getStage("s0"))?.credentialsRef, "vault://x");
    });

    it("advances the cursor only from the expected sha", async () => {
      await seedBasics(h.store);
      const next = { sha: "next", prNumber: 7, updatedAt: "2026-09-13T12:00:00.000Z" };
      assert.equal(await h.store.advanceCursor("s1", "stale", next), false);
      assert.equal((await h.store.getStage("s1"))?.cursor?.sha, "base");
      assert.equal(await h.store.advanceCursor("s1", "base", next), true);
      assert.deepEqual((await h.store.getStage("s1"))?.cursor, next);
      await assert.rejects(h.store.advanceCursor("missing", "base", next));
    });

    it("lets exactly one concurrent cursor advance win", async () => {
      await seedBasics(h.store);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          h.store.advanceCursor("s1", "base", { sha: `head-${i}`, updatedAt: "2026-09-13T12:00:00.000Z" }),
        ),
      );
      assert.equal(results.filter(Boolean).length, 1);
    });

    it("sets the cursor unconditionally and rejects unknown stages", async () => {
      await seedBasics(h.store);
      await h.store.setCursor("s1", { sha: "manual", updatedAt: "2026-09-13T12:00:00.000Z" });
      assert.equal((await h.store.getStage("s1"))?.cursor?.sha, "manual");
      assert.equal(await h.store.advanceCursor("s1", "manual", { sha: "x", updatedAt: "2026-09-13T12:00:00.000Z" }), true);
      await assert.rejects(h.store.setCursor("missing", { sha: "x", updatedAt: "2026-09-13T12:00:00.000Z" }));
    });

    it("numbers runs uniquely under concurrency", async () => {
      await seedBasics(h.store);
      const numbers = await Promise.all(Array.from({ length: 20 }, () => h.store.nextRunNumber("s1")));
      assert.deepEqual([...numbers].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it("creates runs, bumps numbering past explicit numbers, and tracks the latest run", async () => {
      await seedBasics(h.store);
      const r = run("run1", {
        number: 41,
        rerunOf: "run0",
        manifest: { path: ".qa/manifest.yaml", commitSha: "bbb", status: "loaded", loadedAt: "2026-09-13T12:00:00.000Z", version: "76bb961" },
      });
      await h.store.createRun(r);
      assert.deepEqual(await h.store.getRun("run1"), r);
      assert.equal(await h.store.nextRunNumber("s1"), 42);
      assert.equal((await h.store.getStage("s1"))?.latestRunId, "run1");
    });

    it("updates runs with a shallow merge", async () => {
      await seedBasics(h.store);
      await h.store.createRun(run("run1"));
      const updated = await h.store.updateRun("run1", {
        status: "blocked",
        verdict: "block",
        checkRunId: 123,
        coverage: { surfacesTotal: 26, surfacesVisited: 20, changedSurfacesTotal: 8, changedSurfacesVisited: 8, invariantsTotal: 10, invariantsChecked: 10 },
      });
      assert.equal(updated.status, "blocked");
      assert.equal(updated.checkRunId, 123);
      assert.equal(updated.change.headSha, "bbb", "untouched fields survive");
      assert.deepEqual(await h.store.getRun("run1"), updated);
      assert.equal((await h.store.listRuns("s1"))[0]?.status, "blocked");
      await assert.rejects(h.store.updateRun("missing", { status: "passed" }));
    });

    it("lists runs by stage number and by repository start time", async () => {
      await seedBasics(h.store);
      await h.store.upsertStage(stage("s2", { order: 2 }));
      await h.store.createRun(run("a", { number: 1, startedAt: "2026-09-13T09:00:00.000Z" }));
      await h.store.createRun(run("b", { number: 2, startedAt: "2026-09-13T08:00:00.000Z" }));
      await h.store.createRun(run("c", { stageId: "s2", number: 1, startedAt: "2026-09-13T10:00:00.000Z" }));
      assert.deepEqual((await h.store.listRuns("s1")).map((r) => r.id), ["b", "a"]);
      assert.deepEqual((await h.store.listRuns("s1", 1)).map((r) => r.id), ["b"]);
      assert.deepEqual((await h.store.listRunsByRepository("r1")).map((r) => r.id), ["c", "a", "b"]);
      assert.deepEqual((await h.store.listRunsByRepository("r1", { stageId: "s1" })).map((r) => r.id), ["a", "b"]);
      assert.deepEqual((await h.store.listRunsByRepository("r1", { limit: 2 })).map((r) => r.id), ["c", "a"]);
    });

    it("saves findings by id, validates runId, and sorts most severe then newest", async () => {
      await seedBasics(h.store);
      await h.store.createRun(run("run1"));
      await h.store.createRun(run("run2", { number: 2 }));
      await h.store.saveFindings("run1", [
        finding("p2-old", { severity: "P2", reportedAt: "2026-09-13T12:00:00.000Z" }),
        finding("p0", { severity: "P0", reportedAt: "2026-09-13T11:00:00.000Z" }),
        finding("p2-new", { severity: "P2", reportedAt: "2026-09-13T13:00:00.000Z" }),
      ]);
      await h.store.saveFindings("run2", [finding("other", { runId: "run2", severity: "P1" })]);
      assert.deepEqual((await h.store.listFindings("run1")).map((f) => f.id), ["p0", "p2-new", "p2-old"]);
      assert.deepEqual((await h.store.listFindingsByRepository("r1")).map((f) => f.id), ["p0", "other", "p2-new", "p2-old"]);
      assert.deepEqual((await h.store.listFindingsByRepository("r1", 2)).map((f) => f.id), ["p0", "other"]);

      await h.store.saveFindings("run1", [finding("p0", { severity: "P0", status: "dismissed" })]);
      assert.equal((await h.store.getFinding("p0"))?.status, "dismissed");
      assert.deepEqual((await h.store.getFinding("p0"))?.reproSteps, finding("p0").reproSteps);
      assert.equal((await h.store.listFindings("run1")).length, 3, "upsert, not duplicate");

      await assert.rejects(h.store.saveFindings("run1", [finding("wrong", { runId: "run2" })]));
    });

    it("stores manifest snapshots per commit and returns the latest", async () => {
      const older = snapshot("c1", "2026-09-13T10:00:00.000Z");
      const newer = snapshot("c2", "2026-09-13T11:00:00.000Z", {
        status: "loaded",
        errors: undefined,
        product: {
          productName: "Nike Storefront",
          intent: "Sell shoes",
          stakeholders: [],
          surfaces: [{ id: "checkout", kind: "flow", name: "Checkout", locator: "/checkout", sources: ["src/app/checkout/**"] }],
          invariants: [{ id: "inv", statement: "s", severityOnViolation: "P0", surfaceIds: ["checkout"] }],
          manifestVersion: "76bb961",
          boundaries: ["no direct db"],
        },
      });
      await h.store.saveManifestSnapshot("r1", newer);
      await h.store.saveManifestSnapshot("r1", older);
      assert.deepEqual(await h.store.getManifestSnapshot("r1", "c1"), older);
      assert.equal((await h.store.getManifestSnapshot("r1", "c2"))?.product?.surfaces[0]?.sources?.[0], "src/app/checkout/**");
      assert.equal((await h.store.getLatestManifestSnapshot("r1"))?.commitSha, "c2");
      assert.equal(await h.store.getLatestManifestSnapshot("r2"), undefined);
    });

    it("dedupes webhook deliveries for 24 hours", async () => {
      assert.equal(await h.store.claimDelivery("d1"), true);
      assert.equal(await h.store.claimDelivery("d1"), false);
      const concurrent = await Promise.all(Array.from({ length: 5 }, () => h.store.claimDelivery("d2")));
      assert.equal(concurrent.filter(Boolean).length, 1);
      await h.backdateDelivery("d1");
      assert.equal(await h.store.claimDelivery("d1"), true);
    });
  });
}

// --- implementations ----------------------------------------------------------

describeStore("memory", async () => {
  const store = new MemoryStore();
  return {
    store,
    backdateDelivery: async (id) => {
      (store as unknown as { deliveries: Map<string, number> }).deliveries.set(id, Date.now() - 25 * 60 * 60 * 1000);
    },
  };
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (testDatabaseUrl) {
  let sql: Sql;
  before(async () => {
    sql = postgres(testDatabaseUrl, { max: 10, onnotice: () => {} });
    await migrate(sql);
  });
  after(async () => {
    await sql.end({ timeout: 5 });
  });

  describeStore("postgres", async () => {
    await sql`
      TRUNCATE installations, repositories, stages, run_counters, runs, findings, manifest_snapshots, webhook_deliveries
    `;
    return {
      store: new PostgresStore(sql),
      backdateDelivery: async (id) => {
        await sql`UPDATE webhook_deliveries SET received_at = now() - interval '25 hours' WHERE id = ${id}`;
      },
    };
  });
} else {
  describe("postgres store contract", () => {
    it("skipped: set TEST_DATABASE_URL to run against Postgres", { skip: true }, () => {});
  });
}
