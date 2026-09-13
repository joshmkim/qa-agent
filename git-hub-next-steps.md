# GitHub Integration: Next Steps

State as of 2026-09-13: `packages/control-plane` has the GitHub App auth,
webhook receiver, installation tracking, diff + PR enrichment, check run
posting, run lifecycle, cursor auto-seeding, failed-deployment runs, and
re-runs from GitHub's "Re-run" button. Those paths have been exercised
locally with signed fake webhooks and a dummy key. It has not been run
against a real GitHub App yet. That is step 1.

## 1. Prove it against a real App (done 2026-09-13)

Verified end to end against `TrentK014/nike-storefront` (a fork of
`joshmkim/nike-storefront`; Next.js + Supabase) with the App
`agentic-qa-fleet-30ba`. Stages: `beta -> main` (`main` is prod). Verdicts were
posted by hand because the orchestrator does not exist yet; everything else
was real GitHub traffic.

- [x] Create the App: `pnpm --filter @qa-agent/control-plane create-app`
      (add `--org <org>` for an org-owned App). The manifest flow gave exactly
      Contents read, Pull requests read, Metadata read, Checks read/write and
      the `push` + `check_run` events; GitHub accepted `check_run` in the
      manifest. Writes `.env`, key in `~/.config/qa-agent/<slug>.pem`, smee
      channel.
- [x] Install on the repo only ("Only select repositories").
- [x] Run `pnpm --filter @qa-agent/control-plane dev` and `... tunnel`.
      If the control plane was not running during install, the
      `installation.created` webhook is lost (and the redirect to
      `/github/setup` shows "refused to connect"); recover with
      `POST /github/installations/<id>/sync`.
- [x] Create `beta` from `main`
      (`gh api repos/<owner>/<repo>/git/refs -f ref=refs/heads/beta -f sha=<main sha>`).
- [x] Fork gotcha: `gh repo set-default TrentK014/nike-storefront` in a clone,
      and pass `--repo` to `gh pr create`; otherwise PRs target upstream.
- [x] Map the stages:
      ```bash
      API=localhost:3001/api/repositories/TrentK014/nike-storefront/stages
      curl -X PUT $API/beta -H 'Content-Type: application/json' -d '{"branch":"beta","order":1,"protectedBranch":"main","fleetSize":10}'
      curl -X PUT $API/prod -H 'Content-Type: application/json' -d '{"branch":"main","order":2,"gatesPromotion":false,"fleetSize":10}'
      ```
- [x] Merge a PR into `beta` (TrentK014/nike-storefront#1): cursor seeded
      from the push's `before`, run #1 started, change context correct
      (`ahead`, 2 commits incl. merge commit, PR #1 with title/author,
      `changedFiles` = `src/components/SaleSticker.tsx`), in-progress
      "Agentic QA Fleet" check posted by the App on the head commit.
- [x] Branch protection on `main` requiring `Agentic QA Fleet` from this App
      (`app_id` pinned). Promotion PR `beta -> main`
      (TrentK014/nike-storefront#2) is BLOCKED while the check runs.
- [x] Post a P0 finding + `block` verdict: check -> failure, PR stays BLOCKED.
- [x] Click "Re-run" in GitHub: `check_run.rerequested` started run #2
      (`trigger: rerun`, `rerunOf` run #1) at the same SHA with the cursor
      unchanged; `pass` -> check success, PR CLEAN.
      (`POST .../check-runs/:id/rerequest` via a user token returns 404; only
      the App or the UI button can re-request.)
- [x] Failure path: bogus cursor on `beta`, push: run #3 `failed`
      (`compareStatus: unavailable`, reason "Not Found"), `action_required`
      check "could not assemble change context", cursor unchanged.
- [x] CI trigger: reseed cursor, `POST /api/runs {repository, stage}` computed
      the right window (1 commit, `README.md`, 0 PRs) and posted a check;
      `pass` made the promotion PR CLEAN again.

Still to check:

- [ ] Promotion diff: merge `beta -> main` and confirm the `prod` run's
      compare (`ahead`, or `diverged` with merge-base fallback). Note that
      `prod` has `gatesPromotion: false` but still runs QA on push.
- [ ] `details_url` opens the run page: start the web with
      `CONTROL_PLANE_URL=http://localhost:3001` and click "Details" on a check.
- [ ] Org install: `installation.created` payload shape for `account` on an
      org install (only a user install has been exercised).
- [ ] Add `gamma` as a middle stage when a three-stage demo is wanted.
- [ ] Not needed for the App, but needed by the agents: a URL per stage (e.g.
      Vercel branch deployments) and Supabase data for beta kept separate
      from prod.

Found while testing:

- [ ] `PUT .../stages/:stage/cursor` accepts any string. Validate the SHA
      exists (`repos.getCommit`) and expand short SHAs before storing.
- [ ] The failed-run reason is Octokit's raw message ("Not Found -
      https://docs.github.com/..."). Map common cases to plain text, e.g.
      404 on compare -> "cursor SHA not found in this repository".

## 2. Failed-compare behavior (decided, built)

When a push's compare fails (bad cursor SHA, revoked installation, rate
limit), `RunService.detectDeployment` records a `failed` run
(`change.compareStatus: "unavailable"`, reason in the failed step), posts a
completed `action_required` check on the head SHA, and emits
`deployment.failed` (Slack posts a short notice). The cursor is not advanced,
so the next push retries from the same base. Re-running that run from GitHub
recomputes the diff from the original base and advances the cursor only if
it still points at that base.

## 3. Durable storage

`MemoryStore` loses everything on restart, including installations. The
`Store` interface in `src/store/index.ts` is the seam.

- [ ] Postgres implementation. Tables: installations, repositories, stages,
      runs, findings, webhook_deliveries. `advanceCursor` becomes
      `UPDATE stages SET cursor = $next WHERE id = $id AND cursor->>'sha' = $expected`.
- [ ] Delivery dedupe with a TTL (the memory version expires after 24h).
- [ ] On boot, if the store is empty, offer `POST /github/installations/:id/sync`
      or iterate `app.eachInstallation` to rebuild the repo inventory.

## 4. Auth on everything except the webhook

Every `/github/*` and `/api/*` route is unauthenticated and has no tenant
scoping. Before this is reachable from anywhere but localhost:

- [ ] Service-to-service token for CI callers of `POST /api/runs` and the
      orchestrator's `/complete` and `/fail`.
- [ ] User login for the web UI, likely GitHub OAuth via the same App
      (`app.oauth` is already available on the `App` instance). Map a logged-in
      user to installations they can administer using
      `GET /user/installations`.
- [ ] Scope every store read by installation once users exist.

## 5. Webhook processing off the request path

Handlers are fire-and-forget in process. Fine for one instance, wrong for two.

- [ ] Persist the raw delivery first, then enqueue (SQS, pg-boss, or
      BullMQ). The HTTP handler should only verify, dedupe, store, and ack.
- [ ] Retry policy for compare and check-run calls; Octokit's retry and
      throttling plugins are already loaded via the `octokit` package but the
      handler has no dead-letter path.
- [x] Idempotency: re-processing a `push` delivery must not create a second
      run. The CAS on the cursor already prevents this for the same head SHA;
      a replayed delivery after a later push fails with `cursor-conflict`,
      which is now logged at info level as expected.

## 6. Diff quality

- [ ] Replace per-commit `listPullRequestsAssociatedWithCommit` with a
      GraphQL query on `associatedPullRequests` batched by commit. Current
      approach is N+M REST calls for N commits and M PRs; a 200-commit window
      burns a noticeable slice of the 5000/hr installation budget.
- [x] Surface `filesTruncated` on `ChangeContext` when the compare hits the
      300-file cap. `changedFiles` (path, status, additions, deletions) is
      also kept for marking surfaces touched by the change.
- [ ] Revert collapse only matches exact `Revert "<title>"` pairs. Decide
      whether partial reverts should be flagged rather than dropped.
- [ ] Squash merges with a PR body that references issues in other repos
      currently produce `owner/repo#123` strings; decide whether to resolve
      them or leave as opaque references for the agents.

## 7. Wire the check run into the web UI

- [x] `details_url` must resolve to a page. Pipeline id is now the repository
      id on both sides (`control-plane/src/pipelines.ts`), matching `runUrl`.
- [x] Web `src/lib/data.ts` reads from the control-plane when
      `CONTROL_PLANE_URL` is set (`GET /api/pipelines/...`, `/api/runs/:id`,
      findings routes). See `pipeline-steps.MD`.

## 8. GHES

Config already supports `GITHUB_API_BASE_URL`. Untested. When a GHES tenant
shows up: verify `deriveWebBaseUrl`, webhook header names (same), and that
the App is created on the GHES instance, not github.com.

## 9. Runtime

Octokit and `@slack/web-api` are pinned to the last majors that support
Node 18.20. The dev machine now runs Node 20.19; once the deploy target is
also Node 20+, bump
`octokit` to 4.x, `@octokit/app` to 15+/16+, `@slack/web-api` to 8.x, and
`@hono/node-server` to 2.x, and re-run typecheck (the `App` generic typing in
`src/github/app.ts` may simplify).

## Not GitHub, but blocks the gate from meaning anything

The check run only completes when something calls `completeRun`. That is the
orchestrator + triage judge, which do not exist. Until then the check stays
in progress forever and branch protection will block every promotion. For
demos, call `POST /api/runs/:id/findings` and then `POST /api/runs/:id/complete`
by hand (counts are derived from stored findings when omitted). To demo the
UI with no App at all, use the dev seed
(`DEV_SEED=true`, `pnpm --filter @qa-agent/web seed`).
