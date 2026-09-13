# Code primitives

Code primitives are a team-owned file in the repository under test that tells
the agent fleet what the product is, what to cover, and what must never
break. The control plane reads them from `.qa/manifest.yaml` at each run's head
commit, so a finding always refers to the code primitives that were in force
for that deployment.

A run without code primitives still happens: agents explore without product
context and can only catch hard errors. Invalid code primitives never block a
deployment; the run records a failed "Load code primitives" step with the
validation errors, and the GitHub check lists them.

(The file path, API routes, types and the `manifest:check` command keep the
earlier "manifest" name.)

## Validate locally

```bash
pnpm --filter @qa-agent/control-plane manifest:check path/to/.qa/manifest.yaml
# preview which surfaces a change would mark as touched
pnpm --filter @qa-agent/control-plane manifest:check path/to/.qa/manifest.yaml --changed src/components/SaleSticker.tsx
```

## Format (version 1)

```yaml
version: 1

product:
  name: Nike Storefront                # required
  intent: >-                           # required: what the product is for, in plain language
    Shoppers browse shoes by category, add sized items to their bag, and check out.
  stakeholders: [storefront team]      # optional

surfaces:                              # what the fleet is expected to cover
  - id: checkout                       # lowercase letters, digits, - and _; unique
    kind: flow                         # page | form | button | endpoint | flow
    name: Checkout
    locator: /checkout                 # route, selector, or endpoint path
    description: Bag summary, discount code, place order.   # optional
    sources:                           # optional repo path globs that implement it
      - src/app/checkout/**
      - src/app/api/checkout/**

invariants:                            # statements that must always hold
  - id: discount-counted-on-order      # unique
    statement: A discount code's used_count increases only when an order is created with it.
    severity: P0                       # P0 | P1 | P2 | P3, applied when violated
    surfaces: [checkout]               # optional; must reference surface ids
    check: optional machine-checkable expression   # optional; otherwise LLM-judged

boundaries:                            # optional; things agents must never do
  - Use only the app's pages and /api routes; never call the database directly.
```

### Fields

| Field | Used for |
|---|---|
| `product.intent` | The oracle for LLM-judged findings: behavior that contradicts it is a bug. |
| `surfaces[].sources` | Marking a surface as **touched by the change** when a changed file matches a glob. Touched surfaces get agent priority and are listed on the GitHub check. Unmapped surfaces are still covered but never marked touched. If GitHub truncated the change's file list (300+ files), every mapped surface counts as touched. |
| `invariants[]` | Scored by the triage judge; a violation uses the invariant's `severity`. Invariants are the highest-leverage part of the code primitives. |
| `boundaries` | Passed to every agent as blast-radius limits. |

### Globs

`sources` use [picomatch](https://github.com/micromatch/picomatch) syntax,
matched against repo-relative paths. `**` matches any depth. Square brackets
are character classes, so a Next.js dynamic segment like `[id]` must be
escaped as `[[]id]` or matched with `*` (`src/app/api/shoes/*/stock/**`).

### Version

The code primitives version shown in the UI and on checks is the file's short
blob SHA, so it changes exactly when the content changes.

## How agents receive it

`GET /api/runs/:id/context` returns the `RunContext` for a run (see
`packages/shared-types/src/context-bundle.ts`): the change under test, the
product context from these code primitives with touched surfaces marked, and
the stage environment (`environmentUrl`, `credentialsRef`, and the code
primitives' boundaries). The orchestrator adds agent id, persona, and saturated surfaces
to build each agent's `ContextBundle`.
