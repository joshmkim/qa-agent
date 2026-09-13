# Agentic QA Fleet

Fleet-driven QA gate for pre-production pipelines. See `project-context.md` for the vision and architecture.

## 01 · Project overview

Manual QA on preprod environments exists because integration tests can't cover every edge case — but it doesn't scale. Agentic QA Fleet replaces that manual pass with a fleet of Claude-powered agents that explore a real deployed environment like human testers and gate promotion on what they find. It connects to a repository's GitHub deployments, computes exactly what changed since the last promotion, spins up a fleet of agents (Playwright + Claude, one persona each — methodical, chaos-monkey, adversarial-fuzzer, impatient-user) against the live stage environment, dedupes and triages their findings with a judge that blocks promotion on any P0, and reports through GitHub Checks, Slack, and Jira. A Next.js dashboard shows the pipeline as a stage graph with per-stage agent confidence, findings by severity, and drill-down into individual findings with replayable reproduction steps.

Verified so far: a single hand-run agent against a live deployed storefront found 2 real bugs (an advertised discount code rejected at checkout, and a sale badge with no backing discount). A full orchestrated multi-agent run through the control plane end-to-end is the next verification step — see Reliability testing.

## 02 · External apps used

1. **GitHub** (GitHub App) — webhook-driven deploy detection, diff/PR enrichment between stage promotions, and the promotion gate itself via the Checks API + branch protection. Live-tested end-to-end against a real installed App on a real repository.
2. **Slack** — outbound run reports (verdict, confidence statement, findings by severity, coverage, links back to the run) posted to a channel via a bot token. Smoke-tested through the real run-completion code path.
3. **Jira** — outbound issue filing for findings at or above a configurable severity, deduped against issues already filed for the same defect, added to the project's active sprint (not left in the backlog), plus scanning PRs/commits for issue keys to attach back to the change. Filing a genuinely new issue also triggers a Slack notification, wired through a decoupled event rather than Jira calling Slack directly.

## 03 · Setup instructions

### Packages

- `packages/web` – pipeline view + findings UI (Next.js 15, Tailwind v4). Reads through `src/lib/data.ts`: live from the control-plane when `CONTROL_PLANE_URL` is set, fixtures otherwise (force with `DATA_SOURCE=mock|api`).
- `packages/shared-types` – the two real contracts (`ContextBundle`, `Finding`) plus control-plane data shapes (`Pipeline`, `Stage`, `Run`).
- `packages/control-plane` – GitHub App, webhooks, cursors/diff, code primitives loading, check runs, HTTP API, and the fleet orchestrator + triage judge (`src/orchestrator/`). See "Control plane" and "Agent fleet" below.
- `packages/agent` – the exploration agent runtime: Playwright browser session, self-recovering tool primitives (click, type, navigate, read_dom, call_api, ...), reporting tools (file_finding, check_invariant), and the model loop. Spawned N times per run by the orchestrator; also runnable standalone from a `ContextBundle` JSON.

The repository under test describes itself to the fleet with code primitives at `.qa/manifest.yaml`; see [`docs/code-primitives.md`](docs/code-primitives.md). The live environment agents test is described in [`docs/test-environment.md`](docs/test-environment.md).

### Getting started

Requires Node 18.18+ and pnpm 9 (`corepack enable` will pick up the pinned version).

```bash
pnpm install
pnpm dev          # web on http://localhost:3000
```

The control plane stores data in Postgres when `DATABASE_URL` is set (in-memory otherwise, lost on restart). Local database and tests:

```bash
pnpm db:up        # Postgres 16 in Docker on localhost:5433 (databases qa_agent, qa_agent_test)
# packages/control-plane/.env: DATABASE_URL=postgres://qa:qa@localhost:5433/qa_agent
pnpm --filter @qa-agent/control-plane db:migrate   # also runs automatically on boot
TEST_DATABASE_URL=postgres://qa:qa@localhost:5433/qa_agent_test pnpm test
```

Useful routes with the mock data:

- `/` – pipeline dashboard (stage graph beta -> gamma -> prod)
- `/pipelines/pl_storefront/runs/run_beta_47` – a blocked run with P0 findings
- `/pipelines/pl_storefront/runs/run_beta_47/findings/fnd_001` – finding detail with replayable action trace

```bash
pnpm --filter @qa-agent/web build
pnpm --filter @qa-agent/web lint
pnpm --filter @qa-agent/web typecheck
```

### Control plane

1. Create the GitHub App. This uses GitHub's App Manifest flow, writes `packages/control-plane/.env`, stores the private key in `~/.config/qa-agent/`, and creates a smee.io channel for local webhooks:

```bash
pnpm --filter @qa-agent/control-plane create-app   # add --org <org> for an org-owned App
```

2. Install the App on your repo ("Only select repositories"), then run the control plane and the webhook relay:

```bash
pnpm --filter @qa-agent/control-plane dev      # http://localhost:3001
pnpm --filter @qa-agent/control-plane tunnel   # smee.io -> /webhooks/github
```

3. Map stage branches:

```bash
curl -X PUT localhost:3001/api/repositories/<owner>/<repo>/stages/beta \
  -H 'Content-Type: application/json' -d '{"branch":"beta","protectedBranch":"gamma"}'
```

The next push to `beta` seeds the deploy cursor from the push's previous head, starts a run, and posts an in-progress "Agentic QA Fleet" check on the head commit. "Re-run" on that check starts a new run at the same SHA. CI can trigger explicitly with `POST /api/runs {"repository":"owner/repo","stage":"beta"}`, and the orchestrator reports back via `POST /api/runs/:id/complete` or `/fail`. The full go-live checklist against the test repo is in `git-hub-next-steps.md`.

To exercise the UI against the control-plane without a GitHub App, start it with `DEV_SEED=true` and placeholder GitHub env, then:

```bash
pnpm --filter @qa-agent/web seed                     # loads fixtures + an in-flight run_beta_48
CONTROL_PLANE_URL=http://localhost:3001 pnpm dev     # open /pipelines/repo_storefront
```

Route groups: `/webhooks/github` (HMAC-verified), `/github/*` (onboarding + installation inventory), `/api/*` (stages, cursors, runs, findings, pipelines). Only the webhook route is authenticated today. Slack reporting is outbound only (no routes); set `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` to enable it.

### Agent fleet

With `ANTHROPIC_API_KEY` set, the control-plane orchestrates every run it starts: it takes the run's context from the run service (change, code primitives with touched surfaces, stage environment and budget), builds one persona per agent (methodical / chaos-monkey / adversarial-fuzzer / impatient-user, each focused on surfaces touched by the change), runs agents in waves of `FLEET_CONCURRENCY`, steers later waves away from saturated surfaces, dedupes findings across agents, and completes the run with a verdict (`block` on any P0) and a confidence statement. The stage needs an `environmentUrl` (and can set `budgetSeconds` per agent):

```bash
pnpm --filter @qa-agent/agent install-browsers   # once; downloads Chromium
curl -X PUT localhost:3001/api/repositories/<owner>/<repo>/stages/beta \
  -H 'Content-Type: application/json' \
  -d '{"branch":"beta","protectedBranch":"gamma","environmentUrl":"https://beta.example.com","fleetSize":4}'
```

Each agent sees the full diff (patches, PR titles/bodies, linked issues), the surface inventory and invariants from the code primitives, its persona, and the environment boundaries. It acts only through tools; each tool recovers from the usual stalls (overlays, slow renders, ambiguous targets) and returns a structured failure that lists what is actually on screen. 5xx responses, crashes and uncaught exceptions are auto-filed as findings even if the agent never notices them.

Run one agent by hand from a bundle, or the offline smoke tests (no key, no network):

```bash
pnpm --filter @qa-agent/agent bundle -- --manifest ../repo/.qa/manifest.yaml --base-url https://beta.example.com --out /tmp/bundle.json
cd packages/agent && ANTHROPIC_API_KEY=... pnpm exec tsx src/cli.ts --bundle /tmp/bundle.json --headed --video
pnpm --filter @qa-agent/agent smoke                    # real Chromium, scripted model, planted bugs
pnpm --filter @qa-agent/control-plane orchestrator-smoke   # waves, dedupe, verdict, coverage
```

Cost guardrails: `MAX_FLEET_SIZE` (default 8) caps `stage.fleetSize`; each agent is bounded by the stage's `budgetSeconds` (fallback `AGENT_BUDGET_SECONDS`, default 600) and `AGENT_MAX_STEPS` (default 150). See `agent-next-steps.md` for what is stubbed.

### Jira

Also outbound only, so no public URL is needed. When a run finishes, findings at or above `JIRA_MIN_SEVERITY` (default P1) are filed as issues, deduped so a recurring defect comments on the existing issue instead of filing a new one. Newly filed issues are placed on the project's active sprint (falling back to the backlog if there is no board or active sprint), and each one also posts a short "new issue filed" notification to Slack — a separate `finding.tracked` event on the `EventBus`, not Jira calling Slack directly. Issue keys mentioned in PRs and commits are recorded on the run's change context.

1. Create a Jira project from a **Software** template (business templates have no `Bug` issue type) and note its key.
2. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
3. Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_PROJECT_KEY` in `packages/control-plane/.env`.

`/healthz` reports `"jira":true` when it is on, and the control plane logs a warning at boot if the project is unreachable. Setup details and the roadmap are in `jira-next-steps.md`.

## 04 · Reliability testing

- **Contract tests**: `pnpm test` runs the same behavioral test suite against both the in-memory store and the Postgres store, proving the two implementations behave identically (`store.contract.test.ts`).
- **Type safety**: `pnpm typecheck` and `pnpm lint` run clean across all four packages.
- **Offline smoke tests**: `pnpm --filter @qa-agent/agent smoke` (real Chromium, scripted model, planted bugs, no API key or network) and `pnpm --filter @qa-agent/control-plane orchestrator-smoke` (waves, dedupe, verdict, coverage) — both pass today.
- **Live-fire GitHub testing**: the full gate lifecycle was exercised against a real installed GitHub App on a real repo — deploy detection, branch-protection blocking, a P0 finding blocking promotion, GitHub's "Re-run" button, and the failure path (bad cursor → `action_required` check, cursor left untouched). Step-by-step log in `git-hub-next-steps.md`.
- **Live agent run**: one agent run by hand with a real Claude model against a live deployed environment (see `docs/test-environment.md`) found 2 real, previously-unknown bugs.
- **Slack**: smoke-tested by posting a real report through `RunService.completeRun`/`failRun` to a live channel.
- **Frontend**: manually driven with a headless browser after each UI change (home, pipeline, findings pages), checking for console errors and visual correctness against the design reference.
- **Known gaps, stated honestly**: the full multi-agent fleet run through the control plane hasn't been executed end-to-end yet; agent credential resolution isn't wired up, so a full run currently hits a login wall (`agent-next-steps.md` §1, §3); Jira — including its sprint placement and the Jira → Slack notification — has not yet been verified against a live site (`jira-next-steps.md`).

## 05 · Demo video

[link here — under 2 minutes]
