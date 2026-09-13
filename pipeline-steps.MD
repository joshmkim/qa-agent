# Pipeline UI: Integration Next Steps

Status as of 2026-09-13. Drift, Phase 1, Phase 2 and Phase 4 polling are
done (see checkboxes). The web reads from the control-plane when
`CONTROL_PLANE_URL` is set and from fixtures otherwise, through
`packages/web/src/lib/data.ts`. The control-plane
(`packages/control-plane`) has a GitHub App, webhook handling, run lifecycle,
a Postgres store (in-memory when `DATABASE_URL` is unset), and a Hono JSON API. This doc is the plan for wiring the
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
POST /api/runs/:id/complete                             orchestrator verdict (CompleteRunInput; findings optional)
POST /api/runs/:id/fail                                 orchestrator infra failure
POST /api/runs/:id/rerun                                same head SHA, cursor untouched
GET  /api/pipelines                                     Pipeline[] (view-model, id == repository id)
GET  /api/pipelines/:id
GET  /api/pipelines/:id/runs?stage=&limit=              newest first
GET  /api/pipelines/:id/findings?limit=                 most severe first
GET  /api/stages/:id
GET  /api/runs/:id/findings
POST /api/runs/:id/findings                             Finding[] upsert; run must be active
GET  /api/findings/:id
POST /dev/seed                                          only when DEV_SEED=true
POST /slack/commands, /slack/interactions               optional
```

Store interface (`src/store/index.ts`): installations, repositories, stages,
cursors (with `advanceCursor` CAS), runs, findings, webhook delivery dedupe.
No manifest, no pipeline entity.

Local end-to-end without a GitHub App: start the control-plane with
`DEV_SEED=true` and placeholder GitHub env (see its `.env.example`), run
`pnpm --filter @qa-agent/web seed`, then `CONTROL_PLANE_URL=http://localhost:3001 pnpm dev`
and open `/pipelines/repo_storefront`. The seed includes an in-flight run,
`run_beta_48`, to post findings to and complete.

## Known drift to fix first

All resolved.

1. Done. `Stage.autoRun?` was already in shared-types; the web Settings stage
   table now shows it (unset = auto-run).
2. Done, option (a): `control-plane/src/pipelines.ts` `toPipeline`.
   `manifestPath`/`manifestVersion` are placeholders until Phase 3. This also
   makes check-run `details_url` (`/pipelines/<repositoryId>/runs/<runId>`)
   match the web routes.
   Original note: `Pipeline` exists only in the web/shared-types. The control-plane models
   `Repository` + `Stage[]`. Decide one of:
   - (a) Pipeline is a view-model: `pipeline.id == repository.id`, name
     defaults to repo name, stages come from `listStages(repositoryId)`,
     `manifestPath`/`manifestVersion` come from the manifest loader. No new
     table. **Recommended for now.**
   - (b) Add a first-class Pipeline entity to the store.
3. Done. Root `pnpm typecheck` covers all three packages. Original note:
   `packages/control-plane` had no `node_modules` in the workspace install. Run `pnpm install` from the root once its deps are settled so the
   root `pnpm build` / `pnpm typecheck` cover all three packages.

## Phase 1: Read path (UI shows real runs)

Goal: the pipeline page renders from the control-plane with real stages,
cursors, and runs, even if runs never complete yet.

Control-plane

- [x] `GET /api/pipelines` -> `Pipeline[]`. Keyed by id rather than
      `owner/repo` because web URLs carry the pipeline id.
- [x] `GET /api/pipelines/:id` -> `Pipeline` view-model from drift item 2.
- [x] `GET /api/pipelines/:id/runs?stage=&limit=` -> `Run[]`, newest first
      (`Store.listRunsByRepository`).
- [x] `GET /api/stages/:id`.
- [ ] CORS / Next proxy. Not needed yet: every page is a server component
      and fetches `CONTROL_PLANE_URL` server-side. Revisit with Phase 5
      client-side actions and auth.

Web

- [x] Add `CONTROL_PLANE_URL` to `packages/web/.env.example` and read it in
      `data.ts`.
- [x] Implement `listPipelines`, `getPipeline`, `getStage`, `listRuns`,
      `getRun` against the endpoints above, with `fetch(..., { cache:
      "no-store" })` so pages are always live (`src/lib/data/control-plane.ts`).
- [x] Keep the fixtures reachable behind `DATA_SOURCE=mock` so the designer
      can keep iterating without a running control-plane. Module-level switch
      in `data.ts`; fixtures moved to `src/lib/data/mock.ts`. Unset
      `DATA_SOURCE` picks api when `CONTROL_PLANE_URL` is set, else mock.
- [x] `export const dynamic = "force-dynamic"` in the root layout.
- [x] `src/app/error.tsx` "Control plane unreachable" boundary (pulled forward
      from Cross-cutting).

Verify: done against the dev seed (every page renders from the control-plane).
Still to do against a real App: seed a repo through the GitHub App onboarding,
`PUT` a beta stage and cursor, push to `beta` (smee relay), watch Run #1 appear
on the stage card as "Assembling context" and the check run land on GitHub.

## Phase 2: Findings persistence and read path

The UI's most valuable screens (run detail, finding detail) need findings in
the store.

Control-plane

- [x] Extend `Store` with `saveFindings(runId, f[])` (no single-item variant),
      `listFindings(runId)`, `listFindingsByRepository(repositoryId,
      limit)`, `getFinding(id)`. Implement in `memory.ts` first.
- [x] `POST /api/runs/:id/findings` (batch, called by the orchestrator/triage
      judge; body `Finding[]`). Validate `runId` matches, reject when run is
      not active.
- [x] `GET /api/runs/:id/findings`, `GET /api/findings/:id`,
      `GET /api/pipelines/:id/findings?limit=`.
- [x] Make `POST /api/runs/:id/complete` compute `FindingCounts` from stored
      findings when the caller omits it, so the two can't disagree
      (`countFindings` in `runs/service.ts`: duplicates and dismissed are
      excluded from the gate counts; `duplicatesCollapsed` sums
      `triage.duplicateCount`, matching the fixtures).

Web

- [x] Implement `listFindings`, `listAllFindings`, `getFinding` in `data.ts`.
- [ ] Evidence of kind `screenshot` is rendered as a placeholder today
      (`content` is a path). Decide storage: S3/GCS presigned URLs written
      into `Evidence.content` by the agent runtime, and switch the placeholder
      to `<img>` with the presigned URL. Until then keep the placeholder.

Verify: done. With the dev seed, `POST /api/runs/run_beta_48/findings` with
fixture findings re-pointed at that run, then `POST .../complete` without
`findings`; counts come back derived and the run page shows the findings.
Posting to a finished run returns 409, a mismatched `runId` 400.

## Phase 3: Code primitives read path

Done. Format and usage: `docs/code-primitives.md`.

- [x] Control-plane: load `.qa/manifest.yaml` at the run's head SHA via
      `contents`, validate (YAML + zod, path-specific errors), cache per
      `(repositoryId, commitSha)` (`src/manifest/load.ts`). Missing or
      invalid code primitives never block a run; they show as a skipped/failed
      "Load code primitives" step and on the check.
- [x] Surfaces map to code with `sources` globs; `touchedByChange` is
      computed per run from `change.changedFiles`.
- [x] `GET /api/pipelines/:id/manifest` (latest snapshot, else default branch
      head) and `GET /api/runs/:id/manifest` (the snapshot the run used).
- [x] Snapshot onto the run: `Run.manifest` (path, commit, status, version,
      errors); coverage totals are filled from the manifest at run start.
- [x] `GET /api/runs/:id/context` -> `RunContext` (change + product +
      environment) for the agent/orchestrator.
- [x] Web: `getPipelineManifest` / `getRunManifest` replace the four
      fixture-only functions; the finding page resolves surface/invariant
      against the run's code primitives; the Code primitives tab shows status, errors,
      sources, and boundaries.
- [x] `manifest:check` CLI for authoring; first real code primitives for
      `TrentK014/nike-storefront`.

## Phase 4: Live updates

Runs take 40 to 60 minutes. The stage card and run detail should move
without a manual refresh.

- [x] Cheapest: client-side polling. `components/auto-refresh.tsx` calls
      `router.refresh()` every 15s while any visible run is active
      (`isRunActive` in shared-types). Used on home, pipeline, runs list and
      run detail.
- [ ] Better: control-plane `GET /api/events` SSE fed by the existing
      `EventBus` (`src/events.ts` already emits deploy/run transitions);
      web subscribes and refreshes on `run.updated` for the current repo.
- [ ] Fleet exploration is one step today. The orchestrator now writes
      "N/M agents done, K raw findings" into `RunStep.detail` after each
      wave (`RunService.progress`). Next: add `RunStep.progress` (0..1) and
      draw a bar under the "Fleet exploration" step in the run page's Steps
      container.

## Phase 5: Actions (the disabled buttons)

Wire in this order; each is a Next route handler calling the control-plane.

| Button (page)               | Control-plane endpoint                      | Notes |
|-----------------------------|---------------------------------------------|-------|
| Trigger run (pipeline)      | `POST /api/runs` (exists)                   | Needs a stage picker modal. |
| Override gate (run)         | `POST /api/runs/:id/complete` with `verdict: "override"` + reason | Should also update the GitHub check run conclusion to `neutral` and record who overrode it (`Run.overriddenBy`, new field). |
| Re-run (run)                | `POST /api/runs/:id/rerun` (exists)         | Keeps the cursor; `trigger: "rerun"`, `rerunOf` set. Just needs the button wired. |
| Dismiss (finding)           | `PATCH /api/findings/:id { status: "dismissed", note }` | New endpoint. |
| Replay repro (finding)      | `POST /api/findings/:id/replay`             | Spawns one agent with the `reproSteps` trace; returns a new run or a `ReplayResult`. Agent runtime exists (`packages/agent`); needs a replay mode that feeds the trace back through `ToolRegistry.dispatch` instead of the model. See `agent-next-steps.md`. |
| Emit regression test        | `POST /api/findings/:id/regression-test`    | Generates a Playwright spec from `reproSteps`; returns file content or opens a PR. Later. |
| Ask the fleet               | `POST /api/runs/:id/ask { question }`       | Conversational interrogation mode. Later. |
| Connect repository (home)   | link to `/github/install` (exists)          | Just a link. |

## Cross-cutting

- Auth. `api.ts` says "No authentication yet." Before the web talks to it
  over anything but localhost: a shared bearer token between web and
  control-plane for server-to-server calls, and user auth on the web (GitHub
  OAuth via the same App is the least new surface area). Gate the mutating
  buttons on a signed-in user so `overriddenBy` is real.
- Postgres. Done: `store/postgres.ts` behind the `Store` interface, used when
  `DATABASE_URL` is set, with migrations and a contract test suite shared
  with `MemoryStore`. Local database via `pnpm db:up`.
- Errors and empty states. Partly done: `src/app/error.tsx` shows "Control
  plane unreachable" with a retry and keeps the top nav. It sits at the root,
  so pipeline header and tabs are not kept; move a boundary into
  `pipelines/[pipelineId]/` if that matters. Not yet checked in a browser
  (the boundary renders client-side).
- Node version. Web is pinned to Next 15.5.x and Tailwind 4.1.x from when the
  dev machine was on Node 18.20. It now runs Node 20.19, so bumping is
  unblocked (also a prerequisite for the newer `@tailwindcss/oxide` native
  binaries); pins are unchanged so far.

## Suggested order

1. ~~Fix the drift.~~ Done.
2. ~~Phase 1 read path with `DATA_SOURCE` switch.~~ Done.
3. ~~Phase 2 findings, using the fixtures as the first payload.~~ Done.
4. ~~Phase 4 polling.~~ Done.
5. ~~Phase 3 code primitives.~~ Done.
6. Auth, then Phase 5 actions starting with Trigger run and Override gate.
7. ~~Postgres.~~ Done.
