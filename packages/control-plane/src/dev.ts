import { Hono } from "hono";
import type { Finding, Repository, Run, Stage } from "@qa-agent/shared-types";
import type { Installation, Store } from "./store";

export interface SeedBody {
  installations?: Installation[];
  repositories: Repository[];
  stages: Stage[];
  runs: Run[];
  findings?: Finding[];
}

/**
 * Dev-only routes, mounted when DEV_SEED=true. Writes straight to the store,
 * bypassing RunService, so the web UI can be exercised end to end without a
 * real GitHub App (no compare, no check runs, no cursor CAS).
 */
export function devRoutes(store: Store): Hono {
  const app = new Hono();

  app.post("/seed", async (c) => {
    const body = (await c.req.json()) as SeedBody;
    for (const inst of body.installations ?? []) await store.upsertInstallation(inst);
    for (const repo of body.repositories ?? []) await store.upsertRepository(repo);
    for (const stage of body.stages ?? []) await store.upsertStage(stage);
    // Oldest first so each stage's latestRunId ends on its newest run.
    const runs = [...(body.runs ?? [])].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const run of runs) await store.createRun(run);

    const byRun = new Map<string, Finding[]>();
    for (const f of body.findings ?? []) byRun.set(f.runId, [...(byRun.get(f.runId) ?? []), f]);
    for (const [runId, findings] of byRun) await store.saveFindings(runId, findings);

    return c.json({
      installations: body.installations?.length ?? 0,
      repositories: body.repositories?.length ?? 0,
      stages: body.stages?.length ?? 0,
      runs: runs.length,
      findings: body.findings?.length ?? 0,
    });
  });

  return app;
}
