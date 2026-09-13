# Agent runtime + orchestrator: next steps

Status as of 2026-09-13. `packages/agent` (exploration agent) and
`packages/control-plane/src/orchestrator` (fleet orchestrator + triage judge)
are built and pass their offline smoke tests (`pnpm --filter @qa-agent/agent
smoke`, `pnpm --filter @qa-agent/control-plane orchestrator-smoke`). Neither
has run against a real model or a real preprod environment yet. This is the
list of what is stubbed, what is single-tenant, and what to do next, roughly
in order.

## 1. First live run (do this first)

- [x] Run one agent by hand against a real deployment. Done 2026-09-13
      against the nike-storefront beta on Vercel, anonymous shopper, 240s
      budget, focus shoe-detail/cart/checkout: 49 steps, 45 model calls,
      2 real P1 findings (advertised discount code YR24 rejected at
      checkout; home-page -35% sticker with no sale_percent in stock), plus
      a video. Recipe: `pnpm --filter @qa-agent/agent bundle -- --manifest
      ~/nike-storefront/.qa/manifest.yaml --base-url <url> --focus a,b --out
      /tmp/b.json`, then from `packages/agent`: `pnpm exec tsx src/cli.ts
      --bundle /tmp/b.json --headed --video --out /tmp/r.json` with the
      control-plane `.env` sourced. Lessons folded in: browser-cancelled
      requests (`ERR_ABORTED`) are not hard errors; the prompt forbids
      guessing credentials; blank `AGENT_MODEL=` is treated as unset; the
      bare `claude-sonnet-4-5` alias is not served, default is 4-6.
- [ ] Still to watch on bigger runs: prompt too long on big diffs (lower
      `patchBudget`), tool results too verbose (snapshot caps in
      `primitives.ts`), and `/api/shoes/<bad id>/stock` returning 500 instead
      of 404 (noticed by hand; the fuzzer disposition should find it).
- [ ] Then a full run through the control-plane on `TrentK014/nike-storefront`
      beta with `MAX_FLEET_SIZE=2`, `AGENT_BUDGET_SECONDS=180`. Set
      `environmentUrl` on the stage first. Check the run page, the check run
      summary, and the Slack report end to end.
- [ ] Record model cost per agent (`AgentResult.modelCalls` is there; add
      token usage from `ModelResponse.usage` to the result) before raising
      the fleet cap.

## 2. Code primitives (landed on main; merged)

The orchestrator now reads `RunService.contextFor(runId)`: the code primitives
snapshot loaded at the run's head commit, with `touchedByChange` derived
from each surface's `sources` globs. The fork's `.qa/manifest.yaml` has 26
surfaces and 10 invariants, so fleet runs get real coverage numbers.
Remaining:

- `Invariant.surfaceIds` and `product.boundaries` are rendered in the prompt;
  `ManifestSnapshot.status` of `missing`/`invalid` still yields an empty
  product (agents discover surfaces themselves, coverage "unmeasured").
- The code primitives' `boundaries` are policy text. URL-level blocking is still
  the global `AGENT_BLAST_RADIUS`; consider a `blocked_urls` list in the
  code primitives so teams own both.
- `scripts/bundle-from-manifest.ts` duplicates the YAML -> ProductContext
  mapping for standalone runs; point it at `manifest/load.ts` once that
  module exposes a file-path entry point.

## 3. Environment and credentials (single-tenant shortcuts to productize)

- `EnvironmentContext.credentialsRef` is `stage:<id>` and nothing resolves it.
  Agents hit a login wall and report it as untested. Needed: per-stage
  secrets reference (Secrets Manager ARN) + a `prepare(session)` hook
  (already on `runAgent`) that logs in or injects a bypass header before the
  loop starts. `InProcessAgentRunner.extraHTTPHeaders` is the plumbing.
- `AGENT_BLAST_RADIUS` is one global env var. Should live on `Stage`
  (`blastRadiusBoundaries: string[]`) and be editable from the Settings tab.
- `seededDataRef` is never set. Per-stage test data description belongs next
  to the credentials.
- State isolation is per browser context only. Agents share the same test
  account/data, so chaos-monkey agents can trip each other. Per-agent test
  accounts (or a `login_as` semantic action that picks from a pool) is the
  next step; per-agent sandboxed stacks are the expensive option.

## 4. Runtime profile: in-process today

`InProcessAgentRunner` runs Chromium inside the control-plane process, N at
a time. That is fine for one tenant on one box and wrong for a product:

- Move agents behind a queue (SQS/Redis) with a worker image that has
  Chromium; `AgentRunner` is the seam, `ContextBundle`/`AgentResult` the
  wire format. Webhook handlers already fire-and-forget, so the same queue
  serves both.
- `DiscoveryBoard` is in-memory per run; becomes a table/Redis hash keyed by
  run id when agents are out of process.
- Screenshots are written to `os.tmpdir()/qa-agent/...` and referenced by
  path in `Evidence.content`. Upload to S3/GCS and store a presigned URL so
  the web `<img>` placeholder can render (pipeline-steps Phase 2).
- Orchestration state lives in the process. If the control-plane restarts
  mid-run the run stays "exploring" forever. Add a sweeper that fails runs
  whose `startedAt` is older than fleet budget + slack, and make
  `orchestrate` resumable from the store (which agents finished).

## 5. Triage judge: deterministic today

`triage.ts` dedupes by `dedupeKey`, attributes PRs by token overlap, blocks
on any P0, and templates the confidence statement. Upgrades, in value order:

- [ ] Clean-session replay: re-run each canonical P0/P1's `reproSteps`
      through `ToolRegistry.dispatch` in a fresh `BrowserSession` (no model)
      and set `reproducedFromCleanSession` from the result. Today that flag
      means "another agent also hit it". Same code path gives the finding
      page's "Replay repro" button and the regression-test emitter.
- [ ] LLM pass over canonical findings: re-score severity against the
      product intent, collapse near-duplicates with different dedupe keys
      (same bug, different error text), and write the confidence statement
      in prose. Slot it after `dedupeFindings`; contract unchanged.
- [ ] Severity policy per stage (block on P1 for prod-adjacent stages).
- [ ] Flaky detection: a finding hit by one agent out of many on a
      well-covered surface should be marked, not promoted.

## 6. Agent quality

- Semantic actions: `ToolRegistry` takes `extraTools`; none exist. First
  ones are `login_as` and whatever the code primitives name as core flows. Author
  them in the repo next to the code primitives so teams own them.
- Observation tools `get_logs`, `get_metrics`, `query_db` are in
  `ActionKind` but have no implementation. They need an
  `ObservationProvider` per stage (CloudWatch log group, read-only DB
  connection) in the environment context.
- Vision: screenshots are only shown to the model when it asks
  (`screenshot` tool). Attaching one automatically after navigations would
  catch layout bugs at the cost of tokens; make it a disposition setting.
- `guessSurface` (URL -> surface for auto-filed errors) only matches
  page/flow locators that are paths. Endpoint surfaces (`kind: "endpoint"`)
  should match the failing request URL instead of the page URL.
- History compaction keeps the last 10 tool rounds verbatim. Tune once we
  see real context sizes; `ModelResponse.usage` is available.
- Token/cost budget per agent in addition to wall clock.

## 7. Contracts touched in this branch

- `ChangedFile.patch?` (shared-types) populated by `diff.ts` from the compare
  API. Large windows can carry a lot of text on the `Run` object; if the
  store moves to Postgres, keep patches out of the hot row.
- `AgentResult` (shared-types) new.
- `ActionKind` extended with the new primitives and reporting tools.
- `RunService.progress(runId, status, step)` new; `countFindings` no longer
  counts stored duplicate rows (sum of `triage.duplicateCount` only).
