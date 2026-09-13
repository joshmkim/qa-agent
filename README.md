# Agentic QA Fleet

Fleet-driven QA gate for pre-production pipelines. See `project-context.md` for the vision and architecture.

## Packages

- `packages/web` – pipeline view + findings UI (Next.js 15, Tailwind v4). Currently runs on mock data through `src/lib/data.ts`; that file is the seam for the control-plane integration.
- `packages/shared-types` – the two real contracts (`ContextBundle`, `Finding`) plus control-plane data shapes (`Pipeline`, `Stage`, `Run`).
- `packages/control-plane` – GitHub App, webhooks, orchestrator (in progress).

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
