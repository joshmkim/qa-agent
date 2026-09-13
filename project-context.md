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
- Codebase/product context: team-owned, versioned "code primitives" in the repo
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
- Deliver findings where work happens: check runs, PR comments, Slack
  reports, and Jira issues in the team's existing backlog.

## Key design decisions still open per-org
- State isolation: per-agent test accounts vs. per-agent sandboxed stacks.
  Current: one isolated beta stack (Vercel + its own Supabase project) with
  10 shared test shoppers; see `docs/test-environment.md`.
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
(`octokit@3`, `@octokit/app@14`) because the dev shell still resolves Node
18.20 (`node --version`); bump once the runtime is Node 20+ everywhere. Same
reason `packages/agent` pins `playwright@1.61.0` (1.62 requires Node 20) and
`@anthropic-ai/sdk@0.125.0`. Postgres still planned for runs/findings; today
the store is an in-memory implementation behind a `Store` interface.

## Integration pattern (decided)
How every reporting sink is wired, established by Slack and followed by Jira.
Future sinks (email, PagerDuty, PR comments) should look the same.
- Sinks subscribe to the `EventBus`; run logic never calls them. Adding one
  touches no core code.
- Outbound only by default. Anything inbound (webhooks, slash commands, OAuth
  callbacks) needs a public HTTPS endpoint, which is the dependency that got
  Slack's slash commands cut from its MVP. Pay it only when a feature earns
  it; both Slack and Jira deliver their value without it.
- A sink failing must never affect the gate. The bus isolates subscribers, and
  each sink isolates its own units of work on top of that, so a dead token or
  an outage degrades reporting and nothing else.
- Config is optional and absence disables the sink, so a fresh clone boots
  with no third-party accounts at all.

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
  optional Slack, optional Jira).
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
- `src/orchestrator/` fleet orchestrator + triage judge (see "Agent runtime
  and orchestration" below). Subscribes to `run.started`; enabled when
  `ANTHROPIC_API_KEY` is set.
- `src/jira/` optional, outbound only: files findings at or above
  `JIRA_MIN_SEVERITY` as issues on `run.finished`, deduping on a
  `qafleet-<dedupeKey>` label stored in Jira rather than locally, and scans
  the change window for issue keys (`ChangeContext.jiraKeys`). Also no
  inbound routes. See `jira-next-steps.md`.
- `src/store/` `Store` interface + `MemoryStore` (installations, repos,
  stages, cursors, runs, findings, delivery dedupe).

## Agent runtime and orchestration (built 2026-09-13, smoke-tested offline)
`packages/agent` is the ephemeral runtime; `packages/control-plane/src/orchestrator`
spawns it. Contracts: `ContextBundle` in, `AgentResult` (findings + trace +
visited surfaces + checked invariants) out, both in shared-types.

Agent (`packages/agent/src`):
- `browser/session.ts` `BrowserSession`: one Chromium context per agent.
  Passively records console errors, uncaught exceptions, crashes, >=400
  responses and dead requests. Enforces blast-radius boundaries by aborting
  matching requests at the network layer. Screenshots to disk
  (`Evidence.content` is the path; object storage is a next step).
- `browser/snapshot.ts` `read_dom` view: interactive elements get refs
  (`e12`, written as `data-qa-ref`) the model can click/type by. Browser-side
  code is a plain-JS string because tsx's `keepNames` injects a `__name`
  helper into serialized callbacks that does not exist in the page.
- `tools/locate.ts` resolves what the model says into an element: ref ->
  explicit prefix (`text=`, `role=`, `testid=`, `css=`) -> CSS -> role+name ->
  label/placeholder/testid -> text, exact before substring, visible first.
- `tools/primitives.ts` navigate, click, type, press_key, select_option,
  scroll, wait_for, go_back, screenshot, read_dom, read_text, call_api. Every
  failure is structured and lists what is on screen; click dismisses
  overlays and falls back to force/dispatch; type falls back to keyboard.
- `tools/observe.ts` get_console_errors, get_network_failures.
- `tools/report.ts` file_finding (validates surface/invariant ids, dedupe key
  per agent, evidence = fresh screenshot + recent errors, repro = trace from
  `stepsFrom`), check_invariant (auto-files at the invariant's severity),
  mark_surface_visited (coverage), done.
- `tools/registry.ts` schemas for the model + dispatch with a 45s ceiling;
  every call becomes an `ActionStep`.
- `prompt.ts` system prompt: persona + disposition script, product intent
  and stakeholders, surface inventory (marks: touched / saturated / focus),
  invariants, environment + boundaries, PRs with bodies, changed-file groups,
  and the code patches under a character budget ordered by relevance to the
  surfaces. Tests and lockfiles sink to the bottom.
- `loop.ts` `ExplorationLoop`: tool-calling loop bounded by
  `budgetSeconds` and `maxSteps`, budget warnings at 15%/60s, history
  compaction of old tool results, model retries with backoff. Hard errors
  drained after every step are auto-filed (5xx -> P1, crash -> P0, uncaught
  exception -> P2, dead request -> P3) on the surface guessed from the URL,
  so they are findings even if the model ignores them.
- `model/` `ModelClient` interface + Anthropic Messages adapter
  (`@anthropic-ai/sdk`, `AGENT_MODEL`, default claude-sonnet-4-6). Bedrock
  is the same call shape via `@anthropic-ai/bedrock-sdk`.
- `index.ts` `runAgent(bundle, opts)`; `cli.ts` runs one from a JSON bundle;
  `scripts/smoke.ts` scripted model vs a local storefront with planted bugs.

Orchestrator (`packages/control-plane/src/orchestrator`):
- Context comes from `RunService.contextFor(runId)` (`RunContext`: change,
  the run's code primitives snapshot with `touchedByChange` from `sources`
  globs, stage environment and `Stage.budgetSeconds`). The orchestrator adds
  agentId, persona, saturated surfaces, and replaces
  `environment.blastRadiusBoundaries` with the URL-level `AGENT_BLAST_RADIUS`
  list: the code primitives' `boundaries` are policy sentences, rendered to the
  agent from `product.boundaries`, not URL rules.
- `personas.ts` disposition mix 40/25/20/15 (largest remainder, interleaved
  so every wave is mixed); focus areas rotate through touched surfaces first.
- `discovery.ts` `DiscoveryBoard`: a surface is saturated after
  `SATURATION_THRESHOLD` consecutive quiet visits; a new distinct finding
  reopens it.
- `runner.ts` `AgentRunner` interface; `InProcessAgentRunner` dynamic-imports
  `@qa-agent/agent` (control-plane still boots without Chromium). This is the
  runtime-profile seam for a container/queue spawn later.
- `triage.ts` dedupe by `dedupeKey` (canonical = shortest repro; hit by
  another agent => `reproducedFromCleanSession`, status `reproduced`),
  suspected PR by token overlap (single PR => that PR), coverage, fleet
  summary, verdict (`block` on any P0), confidence score and a templated
  confidence statement in the fixtures' voice.
- `index.ts` `Orchestrator.orchestrate(run)`: `RunService.progress` moves the
  status through assembling-context -> exploring -> triaging and the three
  step cards (Assemble context / Fleet exploration / Triage & reproduce);
  waves of `FLEET_CONCURRENCY`; findings streamed to the store after each
  wave; any infra failure -> `failRun`. Requires `stage.environmentUrl`.

`RunService.countFindings` now sums canonical `triage.duplicateCount` only;
stored duplicate rows are those same duplicates (matches the fixtures: 41).

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

## Code primitives (built)
`.qa/manifest.yaml` in the repo under test, format in `docs/code-primitives.md`:
product intent, surfaces (with `sources` globs mapping them to code),
invariants (with severity and optional surface refs), and boundaries.
- Loaded at each run's head SHA and cached per `(repository, commit)`;
  `Run.manifest` records path, commit, status, and version (short blob SHA).
- Missing/invalid code primitives never block a run: a skipped/failed "Load
  code primitives" step and a note on the GitHub check.
- `touchedByChange` is computed per run from `change.changedFiles`; the
  check lists touched surfaces and coverage totals are filled at run start.
- `GET /api/runs/:id/context` returns `RunContext` (change + product +
  environment). The orchestrator adds agentId, persona and saturated
  surfaces to make each agent's `ContextBundle`. Stage `credentialsRef` and
  `budgetSeconds` feed the environment.
- Authoring: `pnpm --filter @qa-agent/control-plane manifest:check <file>`.

## Web integration (built)
`packages/web/src/lib/data.ts` is the only data seam. It uses
`src/lib/data/control-plane.ts` (server-side fetches to `CONTROL_PLANE_URL`,
`no-store`) when `CONTROL_PLANE_URL` is set or `DATA_SOURCE=api`, and the
fixtures in `src/lib/data/mock.ts` otherwise. The Code primitives tab and
finding pages read the code primitives snapshot the run used. Pages that
show in-flight runs poll with `router.refresh()` every 15s. Remaining
integration work is tracked in `pipeline-steps.MD`.
