# Slack bot: next steps

State as of 2026-09-13: the MVP Slack integration in
`packages/control-plane/src/slack/` is outbound only. It subscribes to
`run.finished` and posts one report per run (verdict, confidence statement,
findings by severity, coverage, fleet, PRs under test, links to the web UI;
or a failure report for infra errors). It typechecks and passed a smoke test
through the real `RunService.completeRun` / `failRun` path.

Because nothing inbound exists, Slack never calls the control plane, so no
public URL or tunnel (ngrok, cloudflared) is needed. The GitHub webhook still
needs one for push-based deploy detection; runs can also be started from CI
via `POST /api/runs` without it.

Slash commands, the deployment notice, and the "Run QA fleet" button were
built, verified, and then cut from the MVP because they require Slack to
reach a public HTTPS endpoint. They're listed below as future work; the
removed code is in git history if we want to restore it rather than rewrite.

## 1. Go live (MVP)

- [ ] Create the Slack app "From a manifest" at https://api.slack.com/apps
      using `packages/control-plane/slack-app-manifest.json` (bot user,
      `chat:write` scope only).
- [ ] Install to the workspace; copy the Bot User OAuth Token (`xoxb-...`).
- [ ] Pick the channel, copy its ID (channel details -> About), and
      `/invite @QA Fleet` there. Without the invite `chat.postMessage` fails
      with `not_in_channel` (logged, run completion unaffected).
- [ ] Set `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `WEB_URL` in
      `packages/control-plane/.env`.
- [ ] Verify: start the control plane, confirm `/healthz` shows
      `"slack":true`, create a run, then `POST /api/runs/:id/complete` with a
      sample body and check the report lands in the channel. Check the
      four-field section renders acceptably on mobile.

## 2. Close the "missed deployment" gap

The compare runs before the cursor advances, so a failed compare leaves the
cursor untouched and produces no run; the only signal is a log line.

- [ ] Add a `deployment.failed` event (repository, stage, headSha, reason).
- [ ] Emit it from the push handler when `computeChange` throws.
- [ ] Notifier posts a short notice so the team knows a deployment was
      skipped and will be picked up on the next push.

## 3. Richer reports

Today the report uses `FindingCounts` only. Findings are now persisted
(`store.listFindings(runId)`, most severe first), so this is unblocked.

- [ ] List the top N findings (P0/P1 first) with title, surface, and a
      link. Cap at ~5; link to the web UI for the rest.
- [ ] Show `triage.suspectedPrNumber` next to each finding when present.
- [ ] Optional: a "run started" notice on `run.started` (outbound, so still
      no public URL) and thread the report under it. Requires persisting the
      Slack message `ts` on the run so a restart doesn't lose the thread.

## 4. Inbound: kickoff from Slack (needs a public HTTPS endpoint)

Restore from git history or rebuild:
- [ ] `/qa run <owner/repo> <stage> [sha]`, `/qa status`, `/qa help`
      (slash command -> `/slack/commands`).
- [ ] Deployment notice with a "Run QA fleet" button for stages with
      `autoRun: false` (interactivity -> `/slack/interactions`), edited in
      place when the run starts.
- [ ] Request signature verification (`v0=` HMAC, 5-minute replay window),
      3-second ack with background work, errors via `response_url`.
- [ ] `SLACK_SIGNING_SECRET` back in config; `commands` scope, slash
      command, and interactivity URL back in the manifest.
- [ ] Authorization: allowlist or group check on who may run.
- [ ] Alternative if a public URL stays blocked: Slack Socket Mode
      (`@slack/socket-mode`, app-level token). Outbound WebSocket from the
      control plane, no inbound URL, but a persistent connection per instance.

## 5. Gate actions from Slack (also inbound)

- [ ] "Override and promote" on blocked runs -> verdict `override`, check run
      neutral. Needs the authorization story first.
- [ ] "Re-run" on finished runs. Requires relaxing the cursor CAS for a
      re-run at the same head.

## 6. Multi-tenant Slack (required before customers can install it)

Current wiring is single-workspace: one bot token and one channel from env.
Message builders and the event-bus subscription are tenant-agnostic; only
the token/channel source changes.

- [ ] Slack OAuth v2 install flow (`/slack/install`, `/slack/oauth/callback`)
      storing `{ teamId, botToken, botUserId, installedBy }` per workspace.
      Note this is inbound (Slack redirects to the callback), so it also
      needs a public URL.
- [ ] Link a Slack workspace to a tenant (GitHub installation).
- [ ] `Stage.slackChannelId?` chosen in the web UI; notifier resolves
      `{ token, channel }` from the run's repository. Cache `WebClient` per
      token.
- [ ] Keep the env-var path as single-workspace mode for self-hosted/local.
- [ ] Handle `tokens_revoked` / `app_uninstalled` (Events API).

## 7. Hardening

- [ ] Confirm `@slack/web-api` default 429 retry config is acceptable.
- [ ] Per-stage mute (`notify: false`) for noisy branches.
- [ ] Tests: turn the smoke script into `src/slack/*.test.ts` (report
      rendering, escaping, failure report, notifier error isolation) and
      restore the `test` script in `package.json`.

## 8. Documentation

- [ ] Add a "Slack" section to the root `README.md` with the four setup
      steps from section 1.
