# Slack bot: next steps

State as of 2026-09-13: the Slack integration in `packages/control-plane/src/slack/`
is built, typechecks, and passed a smoke test against the merged control-plane
(signature verification, `/qa` commands, button kickoff, threaded reports).
It has not yet been exercised against a real Slack workspace.

## 1. Go live against a real workspace

- [ ] Create the Slack app at https://api.slack.com/apps.
  - Bot token scopes: `chat:write`, `commands`.
  - Slash command `/qa` -> `https://<public host>/slack/commands`.
  - Interactivity enabled -> `https://<public host>/slack/interactions`.
  - Install to the workspace; invite the bot to the target channel.
- [ ] Fill `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID` in
      `packages/control-plane/.env` (see `.env.example`).
- [ ] Local dev needs a public URL for Slack callbacks. Reuse the smee.io relay
      pattern from the GitHub webhook, or ngrok. Both `/slack/*` routes need it.
- [ ] Manual verification checklist:
  - `/qa help`, `/qa status <owner/repo>` reply ephemerally.
  - Push to a stage with `autoRun: false` -> deployment message with the
    Run QA button; click it -> message edits in place to "run started".
  - `/qa run <owner/repo> <stage>` -> ack, then a run-started message.
  - `POST /api/runs/:id/complete` -> report threaded under the start message
    and broadcast to the channel.
  - Confirm rendering of the report `fields` section on mobile (four fields
    wrap to two columns; check nothing truncates).

## 2. Close the "missed deployment" gap (done)

If the compare fails, the cursor stays put and a failed run is recorded (see
`git-hub-next-steps.md` §2).

- [x] `deployment.failed` event in `src/events.ts` (repository, stage,
      headSha, reason, run).
- [x] Emitted from `RunService.detectDeployment` when `computeChange` throws.
- [x] Notifier posts a short notice ("Couldn't assemble context for
      `abc1234` on `beta`… the next push retries from the same base") with a
      link to the failed run. No button, no thread.

## 3. Durable message tracking

`SlackNotifier` keeps two in-memory maps (pending deployments keyed by
`stageId:headSha`, run messages keyed by `runId`). A restart between run start
and run finish loses the thread, so the report posts unthreaded.

- [ ] Add `slackMessage?: { channel: string; ts: string }` to `Run` in
      shared-types (or a side table) and persist it via `store.updateRun`.
- [ ] Persist the pending-deployment handle on the stage or in a small
      `deployments` table once Postgres lands.
- [ ] Drop the in-memory maps once both are stored.

## 4. Richer reports

Today the report uses `FindingCounts` only. Findings are now persisted
(`store.listFindings(runId)`, most severe first), so this is unblocked.

- [ ] Once findings are persisted, list the top N (P0/P1 first) with title,
      surface, and a link to the finding page. Cap at ~5 to stay under Block
      Kit limits; link to the web UI for the rest.
- [ ] Include the suspected PR (`triage.suspectedPrNumber`) next to each
      finding when present; that is the thing an on-call wants first.
- [ ] Consider a mid-run progress edit (agents completed / findings so far)
      on the start message once the orchestrator emits progress events.

## 5. Gate actions from Slack

The report shows the verdict but offers no way to act on it.

- [ ] "Override and promote" button on blocked runs -> sets verdict
      `override`, completes the check run as neutral. Needs an authorization
      story first (who may override; see auth work for the web UI).
- [ ] "Re-run" button on finished runs -> `startRun` with `trigger: manual`
      at the same head SHA. Requires relaxing the cursor CAS for re-runs
      (currently a re-run at the same head is a cursor conflict).

## 6. Routing and configuration

- [ ] Per-stage channel override (`Stage.slackChannelId?`) so beta and gamma
      can notify different channels. Fall back to `SLACK_CHANNEL_ID`.
- [ ] Per-repo or per-stage mute (`notify: false`) for noisy branches.
- [ ] Optional DM to the pusher when their deployment blocks promotion.

## 7. Hardening

- [ ] Rate-limit handling: `@slack/web-api` retries 429s by default, but a
      burst of deployments across many repos could still queue. Confirm the
      default `retryConfig` is acceptable or set an explicit one.
- [ ] Slash commands from channels the bot is not in: `chat.postMessage` to
      `SLACK_CHANNEL_ID` still works, but the ephemeral ack goes to the
      invoking channel. Decide whether `/qa run` should only be allowed from
      the notification channel.
- [ ] `/qa` currently accepts any workspace member. Add a Slack user allowlist
      or group check for `run` (and later `override`) once auth exists.
- [ ] Tests: the smoke script was throwaway. Turn it into
      `src/slack/*.test.ts` (signature verification, command parsing,
      notifier threading) and restore the `test` script in `package.json`.

## 8. Documentation

- [ ] Add a "Slack" section to the root `README.md` mirroring the control
      plane setup steps.
- [ ] Note in `project-context.md` that Slack is a subscriber to the run
      event bus, not a caller into run logic, so future sinks (email,
      PagerDuty, PR comments) follow the same pattern.
