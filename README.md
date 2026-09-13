# Agentic QA Fleet

Fleet-driven QA gate for pre-production pipelines. See `project-context.md` for the vision and architecture.

## Packages

- `packages/web` – pipeline view + findings UI (Next.js 15, Tailwind v4). Reads through `src/lib/data.ts`: live from the control-plane when `CONTROL_PLANE_URL` is set, fixtures otherwise (force with `DATA_SOURCE=mock|api`).
- `packages/shared-types` – the two real contracts (`ContextBundle`, `Finding`) plus control-plane data shapes (`Pipeline`, `Stage`, `Run`).
- `packages/control-plane` – GitHub App, webhooks, cursors/diff, check runs, HTTP API. Orchestrator not started. See "Control plane" below.

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

1. Create a GitHub App (Settings -> Developer settings -> GitHub Apps -> New):
   - Permissions: Contents read, Pull requests read, Metadata read, Checks read/write.
   - Subscribe to events: push, pull_request, check_run, installation, installation_repositories.
   - Webhook URL: your public URL + `/webhooks/github` (use a smee.io channel locally).
   - Set a webhook secret and generate a private key.
2. `cp packages/control-plane/.env.example packages/control-plane/.env` and fill it in.
3. Run it:

```bash
pnpm --filter @qa-agent/control-plane dev        # http://localhost:3001
npx smee-client --url https://smee.io/XXXX --target http://localhost:3001/webhooks/github
```

4. Install the app on a repo via `http://localhost:3001/github/install` (set the App's "Setup URL" to `/github/setup`), then map a stage branch and seed its cursor with the SHA currently deployed there:

```bash
curl -X PUT localhost:3001/api/repositories/<owner>/<repo>/stages/beta \
  -H 'Content-Type: application/json' -d '{"branch":"beta"}'
curl -X PUT localhost:3001/api/repositories/<owner>/<repo>/stages/beta/cursor \
  -H 'Content-Type: application/json' -d '{"sha":"<deployed sha>"}'
```

The next push to `beta` starts a run and posts an in-progress "Agentic QA Fleet" check on the head commit. CI can trigger explicitly with `POST /api/runs {"repository":"owner/repo","stage":"beta"}`, and the orchestrator reports back via `POST /api/runs/:id/complete` or `/fail`.

To exercise the UI against the control-plane without a GitHub App, start it with `DEV_SEED=true` and placeholder GitHub env, then:

```bash
pnpm --filter @qa-agent/web seed                     # loads fixtures + an in-flight run_beta_48
CONTROL_PLANE_URL=http://localhost:3001 pnpm dev     # open /pipelines/repo_storefront
```

Route groups: `/webhooks/github` (HMAC-verified), `/github/*` (onboarding + installation inventory), `/api/*` (stages, cursors, runs, findings, pipelines). Only the webhook route is authenticated today. Slack reporting is outbound only (no routes); set `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID` to enable it.
