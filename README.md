# Agentic QA Fleet

Fleet-driven QA gate for pre-production pipelines. See `project-context.md` for the vision and architecture.

## Packages

- `packages/web` – pipeline view + findings UI (Next.js 15, Tailwind v4). Reads through `src/lib/data.ts`: live from the control-plane when `CONTROL_PLANE_URL` is set, fixtures otherwise (force with `DATA_SOURCE=mock|api`).
- `packages/shared-types` – the two real contracts (`ContextBundle`, `Finding`) plus control-plane data shapes (`Pipeline`, `Stage`, `Run`).
- `packages/control-plane` – GitHub App, webhooks, cursors/diff, QA manifest loading, check runs, HTTP API, and the fleet orchestrator + triage judge (`src/orchestrator/`). See "Control plane" and "Agent fleet" below.
- `packages/agent` – the exploration agent runtime: Playwright browser session, self-recovering tool primitives (click, type, navigate, read_dom, call_api, ...), reporting tools (file_finding, check_invariant), and the model loop. Spawned N times per run by the orchestrator; also runnable standalone from a `ContextBundle` JSON.

The repository under test describes itself to the fleet with a QA manifest at `.qa/manifest.yaml`; see [`docs/qa-manifest.md`](docs/qa-manifest.md).

## Getting started

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

Useful routes with the fixture data (modelled on `TrentK014/nike-storefront`: real repo, branches, PRs, SHAs, manifest and screenshots; runs and findings are fixtures that mirror bugs observed on the beta deployment):

- `/` – the nike-storefront pipeline (beta -> prod)
- `/pipelines/pl_nike_storefront/runs/run_beta_2` – latest beta run (1 P1: advertised YR24 code rejected)
- `/pipelines/pl_nike_storefront/runs/run_beta_1/findings/fnd_004` – finding detail with action trace and beta screenshots

```bash
pnpm --filter @qa-agent/web build
pnpm --filter @qa-agent/web lint
pnpm --filter @qa-agent/web typecheck
```

## Control plane

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

## Agent fleet

With `ANTHROPIC_API_KEY` set, the control-plane orchestrates every run it starts: it takes the run's context from the run service (change, QA manifest with touched surfaces, stage environment and budget), builds one persona per agent (methodical / chaos-monkey / adversarial-fuzzer / impatient-user, each focused on surfaces touched by the change), runs agents in waves of `FLEET_CONCURRENCY`, steers later waves away from saturated surfaces, dedupes findings across agents, and completes the run with a verdict (`block` on any P0) and a confidence statement. The stage needs an `environmentUrl` (and can set `budgetSeconds` per agent):

```bash
pnpm --filter @qa-agent/agent install-browsers   # once; downloads Chromium
curl -X PUT localhost:3001/api/repositories/<owner>/<repo>/stages/beta \
  -H 'Content-Type: application/json' \
  -d '{"branch":"beta","protectedBranch":"gamma","environmentUrl":"https://beta.example.com","fleetSize":4}'
```

Each agent sees the full diff (patches, PR titles/bodies, linked issues), the surface inventory and invariants from the manifest, its persona, and the environment boundaries. It acts only through tools; each tool recovers from the usual stalls (overlays, slow renders, ambiguous targets) and returns a structured failure that lists what is actually on screen. 5xx responses, crashes and uncaught exceptions are auto-filed as findings even if the agent never notices them.

Run one agent by hand from a bundle, or the offline smoke tests (no key, no network):

```bash
pnpm --filter @qa-agent/agent bundle -- --manifest ../repo/.qa/manifest.yaml --base-url https://beta.example.com --out /tmp/bundle.json
cd packages/agent && ANTHROPIC_API_KEY=... pnpm exec tsx src/cli.ts --bundle /tmp/bundle.json --headed --video
pnpm --filter @qa-agent/agent smoke                    # real Chromium, scripted model, planted bugs
pnpm --filter @qa-agent/control-plane orchestrator-smoke   # waves, dedupe, verdict, coverage
```

Cost guardrails: `MAX_FLEET_SIZE` (default 8) caps `stage.fleetSize`; each agent is bounded by the stage's `budgetSeconds` (fallback `AGENT_BUDGET_SECONDS`, default 600) and `AGENT_MAX_STEPS` (default 150). See `agent-next-steps.md` for what is stubbed.

## Jira

Also outbound only, so no public URL is needed. When a run finishes, findings at or above `JIRA_MIN_SEVERITY` (default P1) are filed as issues, deduped so a recurring defect comments on the existing issue instead of filing a new one. Issue keys mentioned in PRs and commits are recorded on the run's change context.

1. Create a Jira project from a **Software** template (business templates have no `Bug` issue type) and note its key.
2. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
3. Set `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `JIRA_PROJECT_KEY` in `packages/control-plane/.env`.

`/healthz` reports `"jira":true` when it is on, and the control plane logs a warning at boot if the project is unreachable. Setup details and the roadmap are in `jira-next-steps.md`.
