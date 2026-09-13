# Pipeline UI: Integration Next Steps

Status as of 2026-09-13. The web V1 (`packages/web`) renders entirely from
fixtures behind `packages/web/src/lib/data.ts`. The control-plane
(`packages/control-plane`) has a GitHub App, webhook handling, run lifecycle,
an in-memory store, and a Hono JSON API. This doc is the plan for wiring the
two together, in the order that keeps the UI demoable at every step.

## Where the seam is

Every page in `web` reads through one module:

```
packages/web/src/lib/data.ts
  listPipelines()        getPipeline(id)          getStage(id)
  listRuns(pipelineId, stageId?)                  getRun(id)
  listFindings(runId)    listAllFindings(pipelineId)  getFinding(id)
  listSurfaces()         listInvariants()         getSurface(id)  getInvariant(id)
```

Integration means: keep those signatures, replace the bodies with fetches to
the control-plane, and add the endpoints the control-plane doesn't have yet.
Pages and components should not change.

## What the control-plane already exposes

```
GET  /healthz
POST /webhooks/github                                   push, installation events
GET  /github/...                                        App install / onboarding
GET  /api/repositories/:owner/:repo/stages
PUT  /api/repositories/:owner/:repo/stages/:stage       create/replace stage config
PUT  /api/repositories/:owner/:repo/stages/:stage/cursor  seed cursor { sha, prNumber? }
POST /api/runs                                          CI trigger { repository, stage, sha?, triggeredBy? }
GET  /api/runs/:id
POST /api/runs/:id/complete                             orchestrator verdict (CompleteRunInput)
POST /api/runs/:id/fail                                 orchestrator infra failure
POST /slack/commands, /slack/interactions               optional
```

Store interface (`src/store/index.ts`): installations, repositories, stages,
cursors (with `advanceCursor` CAS), runs, webhook delivery dedupe. No
findings, no manifest, no pipeline entity.

## Known drift to fix first

These will bite the moment both packages typecheck together.

1. `Stage.autoRun` is used by the control-plane (`api.ts`, `runs/service.ts`,
   `events.ts`, `slack/blocks.ts`) but does not exist in
   `packages/shared-types/src/pipeline.ts`. Add
   `autoRun: boolean` (default true) to `Stage`, then surface it in the web
   Settings stage table.
2. `Pipeline` exists only in the web/shared-types. The control-plane models
   `Repository` + `Stage[]`. Decide one of:
   - (a) Pipeline is a view-model: `pipeline.id == repository.id`, name
     defaults to repo name, stages come from `listStages(repositoryId)`,
     `manifestPath`/`manifestVersion` come from the manifest loader. No new
     table. **Recommended for now.**
   - (b) Add a first-class Pipeline entity to the store.
3. `packages/control-plane` has no `node_modules` in the workspace install
   yet. Run `pnpm install` from the root once its deps are settled so the
   root `pnpm build` / `pnpm typecheck` cover all three packages.

## Phase 1: Read path (UI shows real runs)

Goal: the pipeline page renders from the control-plane with real stages,
cursors, and runs, even if runs never complete yet.

Control-plane

- [ ] `GET /api/repositories` -> `Repository[]` (list connected repos).
- [ ] `GET /api/repositories/:owner/:repo` -> `Repository` + stages, shaped
      as the `Pipeline` view-model from drift item 2.
- [ ] `GET /api/repositories/:owner/:repo/runs?stage=&limit=` -> `Run[]`,
      newest first. Store already has `listRuns(stageId, limit)`; add a
      repo-wide variant or fan out over stages.
- [ ] `GET /api/stages/:id` (or accept stage id on the existing route).
- [ ] Enable CORS for `WEB_URL` on `/api/*`, or proxy through Next route
      handlers (see below). Proxying is simpler for auth later.

Web

- [ ] Add `CONTROL_PLANE_URL` to `packages/web/.env.example` and read it in
      `data.ts`.
- [ ] Implement `listPipelines`, `getPipeline`, `getStage`, `listRuns`,
      `getRun` against the endpoints above, with `fetch(..., { cache:
      "no-store" })` so pages are always live.
- [ ] Keep the fixtures reachable behind `DATA_SOURCE=mock` so the designer
      can keep iterating without a running control-plane. Do this as a
      module-level switch inside `data.ts`, not per page.
- [ ] Add `export const dynamic = "force-dynamic"` (or `revalidate = 0`) on
      the pipeline pages; they currently render as static at build time.

Verify: seed a repo through the GitHub App onboarding, `PUT` a beta stage and
cursor, push to `beta` (smee relay), watch Run #1 appear on the stage card as
"Assembling context" and the check run land on GitHub.

## Phase 2: Findings persistence and read path

The UI's most valuable screens (run detail, finding detail) need findings in
the store.

Control-plane

- [ ] Extend `Store` with `saveFinding(f)`, `saveFindings(runId, f[])`,
      `listFindings(runId)`, `listFindingsByRepository(repositoryId,
      limit)`, `getFinding(id)`. Implement in `memory.ts` first.
- [ ] `POST /api/runs/:id/findings` (batch, called by the orchestrator/triage
      judge; body `Finding[]`). Validate `runId` matches, reject when run is
      not active.
- [ ] `GET /api/runs/:id/findings`, `GET /api/findings/:id`,
      `GET /api/repositories/:owner/:repo/findings?limit=`.
- [ ] Make `POST /api/runs/:id/complete` compute `FindingCounts` from stored
      findings when the caller omits it, so the two can't disagree.

Web

- [ ] Implement `listFindings`, `listAllFindings`, `getFinding` in `data.ts`.
- [ ] Evidence of kind `screenshot` is rendered as a placeholder today
      (`content` is a path). Decide storage: S3/GCS presigned URLs written
      into `Evidence.content` by the agent runtime, and switch the placeholder
      to `<img>` with the presigned URL. Until then keep the placeholder.

Verify: `curl -X POST /api/runs/<id>/findings` with the fixture findings
from `packages/web/src/lib/mock/findings.ts` (they already satisfy the
`Finding` type), then open the run detail page.

## Phase 3: QA manifest read path

The Manifest tab and the "Invariant violated" callout on finding detail read
`Surface` and `Invariant`. Today both are fixtures.

- [ ] Control-plane: load `.qa/manifest.yaml` from the repo at the run's
      `headSha` via `contents` (already have the permission). Parse to
      `ProductContext`. Cache per `(repositoryId, sha)`.
- [ ] `GET /api/repositories/:owner/:repo/manifest?ref=` -> `ProductContext`.
- [ ] Snapshot the manifest onto the run (`Run.manifestVersion` or a
      `manifestSha`) so a finding always links to the surfaces/invariants
      that were in force when it was found, not the current head.
- [ ] Web: implement `listSurfaces`, `listInvariants`, `getSurface`,
      `getInvariant` against the endpoint. Pass `run.change.headSha` as
      `ref` from the finding page.

## Phase 4: Live updates

Runs take 40 to 60 minutes. The stage card and run detail should move
without a manual refresh.

- [ ] Cheapest: client-side polling. Add a small `"use client"` wrapper that
      calls `router.refresh()` every 15s while any visible run has an active
      status (`queued`, `assembling-context`, `exploring`, `triaging`).
- [ ] Better: control-plane `GET /api/events` SSE fed by the existing
      `EventBus` (`src/events.ts` already emits deploy/run transitions);
      web subscribes and refreshes on `run.updated` for the current repo.
- [ ] Fleet exploration is one step today. Once the orchestrator reports
      per-agent progress, add `RunStep.progress` (0..1) and draw a bar under
      the "Fleet exploration" step in the run page's Steps container.

## Phase 5: Actions (the disabled buttons)

Wire in this order; each is a Next route handler calling the control-plane.

| Button (page)               | Control-plane endpoint                      | Notes |
|-----------------------------|---------------------------------------------|-------|
| Trigger run (pipeline)      | `POST /api/runs` (exists)                   | Needs a stage picker modal. |
| Override gate (run)         | `POST /api/runs/:id/complete` with `verdict: "override"` + reason | Should also update the GitHub check run conclusion to `neutral` and record who overrode it (`Run.overriddenBy`, new field). |
| Re-run (run)                | `POST /api/runs` with `sha = run.change.headSha` | Do not advance the cursor for a re-run. Add `trigger: "rerun"` to `Run.trigger`. |
| Dismiss (finding)           | `PATCH /api/findings/:id { status: "dismissed", note }` | New endpoint. |
| Replay repro (finding)      | `POST /api/findings/:id/replay`             | Spawns one agent with the `reproSteps` trace; returns a new run or a `ReplayResult`. Depends on the agent runtime. |
| Emit regression test        | `POST /api/findings/:id/regression-test`    | Generates a Playwright spec from `reproSteps`; returns file content or opens a PR. Later. |
| Ask the fleet               | `POST /api/runs/:id/ask { question }`       | Conversational interrogation mode. Later. |
| Connect repository (home)   | link to `/github/install` (exists)          | Just a link. |

## Cross-cutting

- Auth. `api.ts` says "No authentication yet." Before the web talks to it
  over anything but localhost: a shared bearer token between web and
  control-plane for server-to-server calls, and user auth on the web (GitHub
  OAuth via the same App is the least new surface area). Gate the mutating
  buttons on a signed-in user so `overriddenBy` is real.
- Postgres. `Store` is already an interface. Add `store/postgres.ts` once
  the findings methods above are settled so the schema is designed once.
  Tables: installations, repositories, stages, runs, findings, deliveries,
  manifests.
- Errors and empty states. The UI has `notFound()` paths and empty-table
  copy, but no "control-plane unreachable" state. Add one at the layout
  level that keeps the header and tabs visible.
- Node version. Web is pinned to Next 15.5.x and Tailwind 4.1.x because the
  dev machine is on Node 18.20. Moving to Node 20+ unblocks newer versions
  and is a prerequisite for the newer `@tailwindcss/oxide` native binaries.

## Suggested order

1. Fix the drift (30 min). Root `pnpm install`, add `autoRun`, make root
   `typecheck` pass across all three packages.
2. Phase 1 read path with `DATA_SOURCE` switch.
3. Phase 2 findings, using the fixtures as the first payload.
4. Phase 4 polling (small, high perceived value).
5. Phase 3 manifest.
6. Auth, then Phase 5 actions starting with Trigger run and Override gate.
7. Postgres.
