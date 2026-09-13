# Project Context: Agentic QA Fleet

## Vision
Replicate and exceed manual QA on preprod (beta/gamma) stages. Before major
releases, companies do manual QA because integration tests cannot cover every
edge case. We spawn a fleet of ~100 independent AI agents that explore a
deployed environment like human testers, with diverse personas and behaviors,
to find production-breaking errors. Output is a pipeline gate: the promotion
proceeds or blocks based on findings.

## Architecture (three layers)

### 1. Context assembly (per deployment)
- Change context: the diff between last deployed position and current head,
  enriched with PR titles/bodies (product description), labels, linked issues.
- Codebase/product context: a team-owned, versioned "QA manifest" in the repo
  (surface inventory of pages/buttons/forms/endpoints, product intent and
  stakeholders, known invariants like "cart total = sum of line items").
  Invariants are the highest-leverage artifact.
- Environment context: stage URLs, test credentials, seeded data, blast-radius
  boundaries.

### 2. Agent runtime (tools, not instructions)
Layered tool hierarchy so agents never stall on mechanics:
- Primitives: click, type, navigate, screenshot, read_dom, call_api
  (wrapping Playwright/CDP).
- Semantic actions: team-authored composites (login_as, add_item_to_cart).
- Observation tools: get_logs, get_metrics, query_db (read-only).
- Reporting: file_finding(severity, repro_steps, evidence), structured and
  machine-dedupable.
Every action self-recovers and returns structured failure.

### 3. Fleet orchestration
- Persona/mandate assignment per agent (user persona, focus area, behavioral
  disposition: methodical, chaos monkey, adversarial fuzzer, impatient user).
- Shared discovery board: agents publish visited states/findings; orchestrator
  steers later agents away from saturated areas.
- Triage judge agent: dedupes, reproduces from clean session, scores against
  invariants, emits ranked report, blocks promotion on P0.

## Form factor decisions
- Spine: pipeline gate + findings as runnable repros (action trace replayable,
  optionally emitted as a regression test).
- Novel mode: conversational interrogation of the fleet's collective run data
  ("did anyone hit the address form with a non-US locale?").
- Headline output is a confidence statement with surface-inventory coverage %.
- Deliver findings where work happens: check runs, PR comments.

## Key design decisions still open per-org
- State isolation: per-agent test accounts vs. per-agent sandboxed stacks.
- Oracle problem: hard errors (free) -> team invariants (authored) -> LLM
  judgment against product description (grows over time).

## MVP scope (decided)
- Connect to GitHub repositories via a GitHub App.
- Each pipeline stage maps to a deployment branch (e.g. beta -> `beta`).
- Diff = compare(last_deployed_cursor ... head). Cursor stores both SHA and
  PR number. First run: the first push to a mapped branch seeds the cursor
  from the push's `before` SHA (manual `PUT .../cursor` still works; a push
  that creates the branch needs manual seeding).
- Cursor advances when a run STARTS (deployment happened regardless of QA).
  Re-runs (GitHub "Re-run" on the check, or `POST /api/runs/:id/rerun`)
  repeat the original change window and never move the cursor, except when
  retrying a failed deployment whose base is still the cursor.
- Deploy detection: push webhook on stage branch by default, plus an explicit
  POST /runs trigger from CI as override.
- Gate via Checks API + branch protection on the next stage's branch.

## GitHub App integration details
- Permissions: Contents read, Pull requests read, Metadata read,
  Checks read/write. Optional: Deployments, Issues write.
- Events: push and check_run (for "Re-run"). Installation events are always
  delivered. No `pull_request` subscription: PR data comes from REST during
  the compare.
- Setup: `create-app` script uses the App Manifest flow so permissions and
  events can't drift; private key lives outside the repo.
- Auth: App JWT (RS256, 10 min) -> installation access token (1 hr), cached
  and refreshed. Use Octokit `App` + `getInstallationOctokit`.
- Webhooks: verify X-Hub-Signature-256 (HMAC-SHA256 over raw body, constant-
  time compare), dedupe on X-GitHub-Delivery, return 200 fast, process async.
- Diff: GET compare/{base}...{head}; per commit GET commits/{sha}/pulls for
  PR enrichment. Handle 250-commit/300-file cap, "diverged" status
  (fall back to merge base), reverts, branch-promotion SHA mismatch
  (track PRs as change identity).
- Store: App ID, private key (secrets manager), webhook secret,
  installation_id per tenant. Make base URL configurable for GHES.
- Local dev: smee.io relay for webhooks.

## Repo structure (decided)
Single monorepo with packages, split later along runtime-profile seam:
- control-plane: GitHub App, webhooks, stage config/cursors, diff + context
  assembly, orchestrator, findings store, triage, Checks integration, API.
- web: pipeline view + findings UI (thin layer over control-plane data).
- agent: the ephemeral runtime spawned N times (Playwright, tool hierarchy,
  exploration loop, finding reporter).
- shared-types: the two contracts that are the system's real API:
  ContextBundle (orchestrator -> agent) and Finding (agent -> orchestrator).

## Stack (decided for control-plane)
TypeScript end to end, pnpm workspaces. Control-plane: Hono on
@hono/node-server, `@octokit/app` + `octokit` (App auth, webhooks, REST,
pagination). Pinned to the last Octokit majors that support Node 18
(`octokit@3`, `@octokit/app@14`) from when the dev machine was on Node 18.20;
it now runs 20.19, so bump once the deploy runtime is Node 20+ too. Postgres
still planned for runs/findings; today the store is an in-memory
implementation behind a `Store` interface.

## First milestone (built, exercised against a real App on 2026-09-13)
Verified on `TrentK014/nike-storefront` with stages `beta -> main`: deploy
detection, change context, check runs, branch-protection gate, GitHub
"Re-run", failed-deployment runs, and the CI trigger. Details and remaining
checks in `git-hub-next-steps.md` §1.

`packages/control-plane` implements the thin slice: push webhook on a
configured stage branch -> compare + PR enrichment -> `deployment.detected`
event -> (if `stage.autoRun`) CAS-advance cursor -> persist run -> in-progress
check run on the head SHA -> `run.started` event. Orchestrator later calls
`completeRun`/`failRun`, which finish the check and emit `run.finished`.

Layout:
- `src/config.ts` env loading (GitHub PEM inline or path, GHES base URL,
  optional Slack).
- `src/events.ts` `EventBus` with `deployment.detected`, `deployment.failed`,
  `run.started`, `run.finished`. Integrations subscribe here, not in the run service.
- `src/github/app.ts` App factory + install URL.
- `src/github/webhooks.ts` Hono router for `/webhooks/github` (verify raw
  body HMAC, dedupe delivery id, 202, async dispatch) + handlers for
  installation lifecycle and push. Repos are learned lazily from push
  payloads too, which covers "all repositories" installs.
- `src/github/onboarding.ts` `/github/*`: install redirect, setup callback,
  installation inventory, `POST /installations/:id/sync` reconcile.
- `src/github/diff.ts` `computeChangeContext` (paginated compare, diverged ->
  merge base, PR enrichment, revert-pair collapse, linked-issue extraction).
- `src/github/checks.ts` create/complete/fail check run.
- `src/runs/service.ts` `RunService`: `detectDeployment`, `startRun`,
  `addFindings`, `completeRun` (derives `FindingCounts` from stored findings
  when omitted), `failRun`, `resolveStage`, `branchHead`.
- `src/api.ts` `/api/*` routes: management (stages, cursors, runs), findings
  ingestion, and id-keyed reads for the web UI.
- `src/pipelines.ts` `toPipeline`: a pipeline is a view over a repository and
  its stages; `pipeline.id == repository.id`.
- `src/dev.ts` `POST /dev/seed`, mounted only with `DEV_SEED=true`; writes
  fixtures straight to the store so the UI can be demoed without an App.
- `src/slack/` optional, outbound only: posts a report to a channel on
  `run.finished` and a short notice on `deployment.failed`. No inbound
  routes, so no public URL is needed for Slack.
- `src/store/` `Store` interface + `MemoryStore` (installations, repos,
  stages, cursors, runs, findings, delivery dedupe).

HTTP API (only /webhooks/github is authenticated; everything else needs auth
+ tenant isolation before public exposure):
- `POST /webhooks/github`
- `GET /github/install`, `GET /github/setup`, `GET /github/installations`,
  `GET /github/installations/:id/repositories`,
  `POST /github/installations/:id/sync`
- `GET /api/repositories/:owner/:repo/stages`,
  `PUT /api/repositories/:owner/:repo/stages/:stage`,
  `PUT /api/repositories/:owner/:repo/stages/:stage/cursor`
- `POST /api/runs` (CI override; body `{repository, stage, sha?}`),
  `GET /api/runs/:id`, `POST /api/runs/:id/complete`, `POST /api/runs/:id/fail`,
  `POST /api/runs/:id/rerun`
- `GET /api/runs/:id/findings`, `POST /api/runs/:id/findings` (`Finding[]`,
  run must be active), `GET /api/findings/:id`
- `GET /api/pipelines`, `GET /api/pipelines/:id`,
  `GET /api/pipelines/:id/runs?stage=&limit=`,
  `GET /api/pipelines/:id/findings?limit=`, `GET /api/stages/:id`
- `POST /dev/seed` (dev only)

Onboarding flow for an external repo: user hits `/github/install` -> GitHub
install page -> picks org + repos -> `installation.created` webhook records
tenant + repos -> user maps stage branches via `PUT .../stages/:stage` and
seeds the cursor via `PUT .../stages/:stage/cursor` -> next push to that
branch starts a run.

Cursor semantics as built: the compare runs *before* the cursor advances, so
a failed compare (bad cursor SHA, revoked install) leaves the cursor where it
was. It records a `failed` run (`compareStatus: "unavailable"`), posts an
`action_required` check on the head SHA, and emits `deployment.failed`.

Deferred / known gaps:
- Webhook handlers run in-process (fire-and-forget); needs a queue once
  there is more than one instance.
- PR enrichment is one REST call per commit + one per PR; switch to GraphQL
  `associatedPullRequests` if rate limits bite on large windows.
- No auth on management routes; no user login / tenant scoping yet.
- `Stage.autoRun` (default true) lets a stage announce deployments without
  starting a run; a run is then started via `POST /api/runs`. Slack kickoff
  (slash command + button) was built and then cut from the MVP because it
  needs Slack to reach a public URL; see slack-next-steps.md.
- `@slack/web-api` is pinned to 7.x (8.x needs Node 20), same reason as the
  Octokit pins.

## Web integration (built)
`packages/web/src/lib/data.ts` is the only data seam. It uses
`src/lib/data/control-plane.ts` (server-side fetches to `CONTROL_PLANE_URL`,
`no-store`) when `CONTROL_PLANE_URL` is set or `DATA_SOURCE=api`, and the
fixtures in `src/lib/data/mock.ts` otherwise. QA manifest reads (surfaces,
invariants) stay on fixtures until the manifest loader exists. Pages that
show in-flight runs poll with `router.refresh()` every 15s. Remaining
integration work is tracked in `pipeline-steps.MD`.
