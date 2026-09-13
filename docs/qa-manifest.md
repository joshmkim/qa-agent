# QA manifest

The QA manifest is a team-owned file in the repository under test that tells
the agent fleet what the product is, what to cover, and what must never
break. The control plane reads it from `.qa/manifest.yaml` at each run's head
commit, so a finding always refers to the manifest that was in force for that
deployment.

A run without a manifest still happens: agents explore without product
context and can only catch hard errors. An invalid manifest never blocks a
deployment; the run records a failed "Load QA manifest" step with the
validation errors, and the GitHub check lists them.

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
| `invariants[]` | Scored by the triage judge; a violation uses the invariant's `severity`. Invariants are the highest-leverage part of the manifest. |
| `boundaries` | Passed to every agent as blast-radius limits. |

### Globs

`sources` use [picomatch](https://github.com/micromatch/picomatch) syntax,
matched against repo-relative paths. `**` matches any depth. Square brackets
are character classes, so a Next.js dynamic segment like `[id]` must be
escaped as `[[]id]` or matched with `*` (`src/app/api/shoes/*/stock/**`).

### Version

The manifest version shown in the UI and on checks is the file's short blob
SHA, so it changes exactly when the manifest content changes.

## How agents receive it

`GET /api/runs/:id/context` returns the `RunContext` for a run (see
`packages/shared-types/src/context-bundle.ts`): the change under test, the
product context from this manifest with touched surfaces marked, and the
stage environment (`environmentUrl`, `credentialsRef`, and the manifest's
boundaries). The orchestrator adds agent id, persona, and saturated surfaces
to build each agent's `ContextBundle`.
