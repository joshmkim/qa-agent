# Agentic QA Fleet

Fleet-driven QA gate for pre-production pipelines. See `project-context.md` for the vision and architecture.

## Packages

- `packages/web` – pipeline view + findings UI (Next.js 15, Tailwind v4). Reads through `src/lib/data.ts`: live from the control-plane when `CONTROL_PLANE_URL` is set, fixtures otherwise (force with `DATA_SOURCE=mock|api`).
- `packages/shared-types` – the two real contracts (`ContextBundle`, `Finding`) plus control-plane data shapes (`Pipeline`, `Stage`, `Run`).
- `packages/control-plane` – GitHub App, webhooks, cursors/diff, check runs, HTTP API, and the fleet orchestrator + triage judge (`src/orchestrator/`). See "Control plane" and "Agent fleet" below.
- `packages/agent` – the exploration agent runtime: Playwright browser session, self-recovering tool primitives (click, type, navigate, read_dom, call_api, ...), reporting tools (file_finding, check_invariant), and the model loop. Spawned N times per run by the orchestrator; also runnable standalone from a `ContextBundle` JSON.

## Getting started

Requires Node 18.18+ and pnpm 9 (`corepack enable` will pick up the pinned version).

```bash
pnpm install
pnpm dev          # web on http://localhost:3000
```

Useful routes with the mock data:

- `/` – pipeline list
- `/pipelines/pl_storefront` – stage graph (beta -> gamma -> prod)
- `/pipelines/pl_storefront/runs/run_beta_47` – a blocked run with P0 findings
- `/pipelines/pl_storefront/runs/run_beta_47/findings/fnd_001` – finding detail with replayable action trace

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

With `ANTHROPIC_API_KEY` set, the control-plane orchestrates every run it starts: it loads the product context (a fallback with no surfaces until the QA manifest loader lands), builds one persona per agent (methodical / chaos-monkey / adversarial-fuzzer / impatient-user, each focused on surfaces touched by the change), runs agents in waves of `FLEET_CONCURRENCY`, steers later waves away from saturated surfaces, dedupes findings across agents, and completes the run with a verdict (`block` on any P0) and a confidence statement. The stage needs an `environmentUrl`:

```bash
pnpm --filter @qa-agent/agent install-browsers   # once; downloads Chromium
curl -X PUT localhost:3001/api/repositories/<owner>/<repo>/stages/beta \
  -H 'Content-Type: application/json' \
  -d '{"branch":"beta","protectedBranch":"gamma","environmentUrl":"https://beta.example.com","fleetSize":4}'
```

Each agent sees the full diff (patches, PR titles/bodies, linked issues), the surface inventory and invariants from the manifest, its persona, and the environment boundaries. It acts only through tools; each tool recovers from the usual stalls (overlays, slow renders, ambiguous targets) and returns a structured failure that lists what is actually on screen. 5xx responses, crashes and uncaught exceptions are auto-filed as findings even if the agent never notices them.

Run one agent by hand from a bundle, or the offline smoke tests (no key, no network):

```bash
ANTHROPIC_API_KEY=... pnpm --filter @qa-agent/agent run -- --bundle bundle.json --headed
pnpm --filter @qa-agent/agent smoke                    # real Chromium, scripted model, planted bugs
pnpm --filter @qa-agent/control-plane orchestrator-smoke   # waves, dedupe, verdict, coverage
```

Cost guardrails: `MAX_FLEET_SIZE` (default 8) caps `stage.fleetSize`, `AGENT_BUDGET_SECONDS` (default 600) and `AGENT_MAX_STEPS` (default 150) bound each agent. See `agent-next-steps.md` for what is stubbed.
