# GitHub Integration: Next Steps

State as of this writing: `packages/control-plane` has the GitHub App auth,
webhook receiver, installation tracking, diff + PR enrichment, check run
posting, and run lifecycle built and typechecking. It has been smoke-tested
locally with a fake App ID (requests reach api.github.com with a signed JWT and
are rejected as "Integration not found"). It has not been run against a real
GitHub App yet. That is step 1.

## 1. Prove it against a real App (do this first)

Nothing below matters until this works end to end.

- [ ] Create a GitHub App on your personal account or a test org.
  - Permissions: Contents read, Pull requests read, Metadata read,
    Checks read/write.
  - Events: push, pull_request, check_run, installation,
    installation_repositories.
  - Setup URL: `<public>/github/setup`. Webhook URL: `<public>/webhooks/github`.
- [ ] Start a smee.io channel, run `pnpm --filter @qa-agent/control-plane dev`,
      fill in `.env` from `.env.example`.
- [ ] Install the App on a throwaway repo with a `beta` branch.
      Confirm `installation.created` lands and `GET /github/installations`
      shows it.
- [ ] `PUT /api/repositories/<owner>/<repo>/stages/beta` then seed the cursor
      with the current `beta` head SHA.
- [ ] Merge a PR to `beta`. Confirm: run created, cursor advanced,
      `ChangeContext.pullRequests` has the PR with title/body/labels, and an
      in-progress "Agentic QA Fleet" check appears on the head commit.
- [ ] `POST /api/runs/<id>/complete` with a `block` verdict. Confirm the
      check flips to failure with the summary.
- [ ] Add branch protection on `gamma` requiring the "Agentic QA Fleet"
      check. Confirm promotion PR from `beta` to `gamma` is blocked.

Things likely to surface here that the smoke test could not:

- `installation.created` payload shape for `account` on org vs user installs.
- Compare API behavior on the first real branch-promotion merge (expect
  `diverged`, expect merge-base fallback to kick in).
- Check run `details_url` currently points at `WEB_URL/pipelines/<repoId>/runs/<runId>`;
  the web package uses pipeline ids like `pl_storefront`, so that URL shape
  needs to be reconciled with whatever the web routes actually are.

## 2. Decide the failed-compare behavior

Current merged behavior: compare runs before the cursor advances. If compare
fails (bad seeded SHA, revoked installation, rate limit), nothing is persisted
and the only trace is a console error. Two options:

- Keep it. Simpler, and a bad cursor keeps failing loudly on every push
  until someone reseeds it.
- Record a failed run anyway so the UI and Slack show something. Requires
  creating the run before compare and marking it `failed` on error.

Pick one and write it into `project-context.md`. Leaning toward the second
once the web UI can display failed runs; until then the first is fine.

## 3. Durable storage

`MemoryStore` loses everything on restart, including installations. The
`Store` interface in `src/store/index.ts` is the seam.

- [ ] Postgres implementation. Tables: installations, repositories, stages,
      runs, webhook_deliveries. `advanceCursor` becomes
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
- [ ] Idempotency: re-processing a `push` delivery must not create a second
      run. The CAS on the cursor already prevents this for the same head SHA,
      but a replayed delivery after a later push would fail with
      `cursor-conflict`, which is correct but should be logged as expected.

## 6. Diff quality

- [ ] Replace per-commit `listPullRequestsAssociatedWithCommit` with a
      GraphQL query on `associatedPullRequests` batched by commit. Current
      approach is N+M REST calls for N commits and M PRs; a 200-commit window
      burns a noticeable slice of the 5000/hr installation budget.
- [ ] Surface `filesTruncated` on `ChangeContext` when the compare hits the
      300-file cap instead of silently substituting PR file counts.
- [ ] Revert collapse only matches exact `Revert "<title>"` pairs. Decide
      whether partial reverts should be flagged rather than dropped.
- [ ] Squash merges with a PR body that references issues in other repos
      currently produce `owner/repo#123` strings; decide whether to resolve
      them or leave as opaque references for the agents.

## 7. Wire the check run into the web UI

- [ ] `details_url` must resolve to a page. Align `runUrl` in `index.ts`
      with the web package's actual route for a run.
- [ ] Web `src/lib/data.ts` currently returns mock data; point it at
      `GET /api/runs/:id` and a new `GET /api/repositories/:owner/:repo/runs`
      (does not exist yet; add to `api.ts`).

## 8. GHES

Config already supports `GITHUB_API_BASE_URL`. Untested. When a GHES tenant
shows up: verify `deriveWebBaseUrl`, webhook header names (same), and that
the App is created on the GHES instance, not github.com.

## 9. Runtime

Local dev is Node 18.20. Octokit and `@slack/web-api` are pinned to the last
majors that support it. Once the deploy target is Node 20+, bump
`octokit` to 4.x, `@octokit/app` to 15+/16+, `@slack/web-api` to 8.x, and
`@hono/node-server` to 2.x, and re-run typecheck (the `App` generic typing in
`src/github/app.ts` may simplify).

## Not GitHub, but blocks the gate from meaning anything

The check run only completes when something calls `completeRun`. That is the
orchestrator + triage judge, which do not exist. Until then the check stays
in progress forever and branch protection will block every promotion. For
demos, call `POST /api/runs/:id/complete` by hand or from the Slack `/qa`
command.
