import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Stage } from "@qa-agent/shared-types";
import { RunError, type CompleteRunInput, type RunService } from "./runs/service";
import type { Store } from "./store";

export interface ApiDeps {
  store: Store;
  runs: RunService;
}

const STATUS_FOR: Record<RunError["code"], 400 | 404 | 409> = {
  "stage-not-found": 404,
  "repository-not-found": 404,
  "run-not-found": 404,
  "no-cursor": 400,
  "run-not-active": 409,
  "cursor-conflict": 409,
};

/**
 * Internal JSON API. Consumers are CI (explicit run trigger), the orchestrator
 * (run completion), and setup tooling (stage config + cursor seeding).
 *
 * No authentication yet: bind to a private network or put it behind a gateway
 * before exposing it. Tracked as part of the auth work for the web UI.
 */
export function apiRoutes(deps: ApiDeps): Hono {
  const { store, runs } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof RunError) {
      return c.json({ error: err.code, message: err.message }, STATUS_FOR[err.code]);
    }
    console.error("[api]", err);
    return c.json({ error: "internal", message: err.message }, 500);
  });

  // --- stages ---

  app.get("/repositories/:owner/:repo/stages", async (c) => {
    const repo = await store.getRepositoryByFullName(`${c.req.param("owner")}/${c.req.param("repo")}`);
    if (!repo) return c.json({ error: "repository-not-found" }, 404);
    return c.json(await store.listStages(repo.id));
  });

  /** Create or replace a stage. Body: Partial<Stage> with at least name + branch. */
  app.put("/repositories/:owner/:repo/stages/:stage", async (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("repo")}`;
    const repo = await store.getRepositoryByFullName(fullName);
    if (!repo) return c.json({ error: "repository-not-found", message: `${fullName} is not connected` }, 404);

    const body = (await c.req.json()) as Partial<Stage>;
    const name = c.req.param("stage");
    const existing = (await store.listStages(repo.id)).find((s) => s.name === name);
    const stage: Stage = {
      id: existing?.id ?? randomUUID(),
      repositoryId: repo.id,
      name,
      branch: body.branch ?? existing?.branch ?? name,
      order: body.order ?? existing?.order ?? 0,
      environmentUrl: body.environmentUrl ?? existing?.environmentUrl,
      cursor: existing?.cursor,
      gatesPromotion: body.gatesPromotion ?? existing?.gatesPromotion ?? true,
      autoRun: body.autoRun ?? existing?.autoRun ?? true,
      protectedBranch: body.protectedBranch ?? existing?.protectedBranch,
      fleetSize: body.fleetSize ?? existing?.fleetSize ?? 10,
      latestRunId: existing?.latestRunId,
    };
    await store.upsertStage(stage);
    return c.json(stage, existing ? 200 : 201);
  });

  /** Seed the deploy cursor. Body: { sha, prNumber? }. */
  app.put("/repositories/:owner/:repo/stages/:stage/cursor", async (c) => {
    const { stage } = await runs.resolveStage(
      `${c.req.param("owner")}/${c.req.param("repo")}`,
      c.req.param("stage"),
    );
    const body = (await c.req.json()) as { sha?: string; prNumber?: number };
    if (!body.sha) return c.json({ error: "bad-request", message: "sha is required" }, 400);
    await store.setCursor(stage.id, {
      sha: body.sha,
      prNumber: body.prNumber,
      updatedAt: new Date().toISOString(),
    });
    return c.json(await store.getStage(stage.id));
  });

  // --- runs ---

  /**
   * Explicit trigger from CI (overrides push detection).
   * Body: { repository: "owner/repo", stage: "beta", sha?: string, triggeredBy?: string }
   */
  app.post("/runs", async (c) => {
    const body = (await c.req.json()) as {
      repository?: string;
      stage?: string;
      sha?: string;
      triggeredBy?: string;
    };
    if (!body.repository || !body.stage) {
      return c.json({ error: "bad-request", message: "repository and stage are required" }, 400);
    }
    const { stage } = await runs.resolveStage(body.repository, body.stage);
    const headSha = body.sha ?? (await runs.branchHead(stage));
    const run = await runs.startRun({
      stage,
      headSha,
      trigger: "api",
      triggeredBy: body.triggeredBy ?? "api",
    });
    return c.json(run, 201);
  });

  app.get("/runs/:id", async (c) => {
    const run = await store.getRun(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "run-not-found" }, 404);
  });

  /** Orchestrator reports the triage verdict. Body: CompleteRunInput. */
  app.post("/runs/:id/complete", async (c) => {
    const body = (await c.req.json()) as CompleteRunInput;
    if (!["pass", "block", "override"].includes(body.verdict)) {
      return c.json({ error: "bad-request", message: "verdict must be pass, block, or override" }, 400);
    }
    return c.json(await runs.completeRun(c.req.param("id"), body));
  });

  /** Orchestrator reports an infra failure. Body: { reason }. */
  app.post("/runs/:id/fail", async (c) => {
    const body = (await c.req.json()) as { reason?: string };
    return c.json(await runs.failRun(c.req.param("id"), body.reason ?? "unknown"));
  });

  return app;
}
