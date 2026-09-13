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
  PR number. First run: user supplies cursor manually; stored after.
- Cursor advances when a run STARTS (deployment happened regardless of QA).
- Deploy detection: push webhook on stage branch by default, plus an explicit
  POST /runs trigger from CI as override.
- Gate via Checks API + branch protection on the next stage's branch.

## GitHub App integration details
- Permissions: Contents read, Pull requests read, Metadata read,
  Checks read/write. Optional: Deployments, Issues write.
- Events: push, pull_request, check_run, installation,
  installation_repositories.
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

## Proposed stack (pending confirmation)
TypeScript end to end. Node 20+, pnpm workspaces, Fastify or Hono for the
control-plane API, Postgres for runs/findings, Octokit, Playwright.

## First milestone (proposed)
Thinnest end-to-end slice, no agents, no UI: GitHub App receives push webhook
on a configured stage branch -> computes diff vs. stored cursor -> enriches
with PR titles/bodies -> persists a run -> posts an in-progress check run
back to GitHub. Proves the GitHub connection everything else builds on.
