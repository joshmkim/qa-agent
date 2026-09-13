# Jira: next steps

State as of 2026-09-13: the Jira integration in
`packages/control-plane/src/jira/` is outbound only. It subscribes to
`run.finished` and files each triaged finding at or above `JIRA_MIN_SEVERITY`
as an issue (summary, context, repro steps, evidence, links back to the
finding and run), deduping against issues it filed before. It also scans the
change window for issue keys and records them on `ChangeContext.jiraKeys`.
It typechecks. It has not been run against a real Jira site yet. That is
step 1.

Like Slack, nothing inbound exists, so Jira never calls the control plane and
no public URL or tunnel is needed — only outbound network access to
`*.atlassian.net`. The GitHub webhook still needs its tunnel for deploy
detection.

Why Jira and not just the findings UI: a finding that blocks a promotion is
work someone has to schedule, and scheduling happens in the tracker. The
higher-leverage half is the reverse direction (§4): a ticket's acceptance
criteria is a product description written *for this specific change*, which
is exactly the oracle the fleet lacks today.

## 1. Go live (MVP)

Everything here is manual setup on a free Jira Cloud plan; no paid features
are used.

- [ ] Create the project at `https://<site>.atlassian.net`. Use a **Software**
      template (Scrum or Kanban), not a business one: business templates ship
      with only Task and Subtask, so `Bug` will not exist and creates will
      fail with "issue type is not valid". Note the project key (e.g. `QA`).
- [ ] Create an API token at
      https://id.atlassian.com/manage-profile/security/api-tokens.
      A classic (unscoped) token works with Basic auth everywhere. If you
      create a **scoped** token instead, grant it `read:jira-work` and
      `write:jira-work` or creates return 403.
- [ ] Fill `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`
      in `packages/control-plane/.env` (see `.env.example`). `JIRA_EMAIL` is
      the Atlassian account email, not a display name.
- [ ] Confirm the issue type. `JIRA_ISSUE_TYPE` defaults to `Bug`; open the
      project's create screen and use whatever is actually there.
- [ ] Start the control plane. `[jira] enabled; …` logs at boot, `/healthz`
      shows `"jira":true`, and a bad token or wrong project logs
      `[jira] cannot reach project …` immediately rather than an hour into a
      run.
- [ ] Verify end to end without an orchestrator: take a run that is still
      active, `POST /api/runs/:id/findings` with a P0 finding, then
      `POST /api/runs/:id/complete` with a `block` verdict. An issue should
      appear in the project within a second or two, and the finding page
      should show its key next to the report timestamp.
- [ ] Verify dedupe: complete a second run carrying a finding with the same
      `dedupeKey`. It should comment "Still reproducing in QA run #N" on the
      existing issue rather than filing a second one.
- [ ] Verify key scanning: put the issue key in a PR title or commit message
      (`QA-1 fix the thing`), merge to a stage branch, and check the run's
      `change.jiraKeys`.

Things likely to surface here that a typecheck cannot:

- Team-managed vs company-managed projects have different field and screen
  configuration. If a create fails with "Field 'x' cannot be set", the field
  is not on that project's create screen.
- `Priority` is deliberately not set. It is absent from many free-plan create
  screens, and one unknown field id fails the whole create, so severity
  travels as the `qa-P0` label instead. Revisit once a real project's screen
  is known.
- Long repro traces and evidence are capped (25 steps, 5 evidence items,
  600 characters each) to stay well inside Jira's field limits. Check whether
  the truncation reads acceptably before raising the caps.

## 2. What is built

`packages/control-plane/src/jira/`:

- `client.ts` — Basic auth against REST v3: `createIssue`, `findIssueByLabel`,
  `addComment`, `verifyAccess`. `JiraError` carries the response body, which
  is where Jira puts the actual reason.
- `issues.ts` — `Finding` → issue fields, including the ADF description tree.
  REST v3 takes rich text as Atlassian Document Format, not a string, so
  there is a small builder here (`paragraph`, `heading`, `bulletList`,
  `orderedList`, `codeBlock`, links). If ADF ever becomes a problem, v2
  accepts plain wiki markup at `/rest/api/2/issue`.
- `keys.ts` — `extractJiraKeys`, filtered to configured project prefixes.
  The `PROJ-123` shape alone also matches `UTF-8`, `SHA-1` and `ISO-8601`,
  so an unfiltered scan is not usable; only prefixes in `JIRA_PROJECT_KEYS`
  (plus `JIRA_PROJECT_KEY`) are kept.
- `reporter.ts` — the `run.finished` subscriber. Skips infra failures,
  dismissed and duplicate findings, and anything below `JIRA_MIN_SEVERITY`.
  Each finding is filed in isolation so one failure cannot stop the rest or
  affect the run.

Searches use `POST /rest/api/3/search/jql`. The older `/rest/api/3/search`
was removed for Cloud in 2025; if you see 410s, that is the endpoint to
check.

## 3. Decisions made while building

Recorded so they can be revisited deliberately rather than rediscovered.

- **Outbound only, no inbound routes.** Same call Slack made: anything Jira
  pushes to us (webhooks, OAuth callbacks) needs a public HTTPS endpoint,
  which is the one dependency that made Slack's slash commands not worth it
  for an MVP. Filing issues needs nothing but network access. Inbound work is
  scoped in §6.
- **Issues are filed on `run.finished`, not as findings arrive.** Findings are
  ingested while a run is still active (`POST /api/runs/:id/findings`), but
  the triage judge reclassifies, dedupes, and drops them, so filing early
  would put raw agent output in the backlog. The cost is that nothing appears
  in Jira until a run completes.
- **Dedupe state lives in Jira, not in the store.** Each issue carries a
  `qafleet-<dedupeKey>` label and the reporter searches for it before
  creating. A local `dedupeKey -> issue key` map was the obvious alternative
  and is wrong here: `MemoryStore` loses everything on restart, so every
  deploy would re-file the whole backlog. Costs one search call per finding.
- **Severity travels as a label (`qa-P0`), not the Priority field.** A single
  field id that is not on the project's create screen fails the entire
  create, and Priority is missing from many free-plan screens. Revisit once a
  real project's configuration is known.
- **REST v3 with ADF, not v2 with wiki markup.** v3 is the current Cloud API;
  the price is the small ADF builder in `issues.ts`. `/rest/api/2/issue`
  takes a plain string and stays the fallback if ADF becomes a problem.
- **Issue-key scanning needs an explicit project allow-list.** `PROJ-123` also
  matches `UTF-8`, `SHA-1` and `ISO-8601`, so an unfiltered scan is unusable.
  Verifying each candidate against the API was rejected: a request per
  candidate, and still wrong for deleted issues. Consequence: no keys are
  recorded until Jira is configured.
- **One issue per finding, not one per run.** A backlog item should be one
  defect someone can pick up. The risk is a badly broken build flooding the
  project; capping and folding the tail into a summary issue is in §8.
- **`trackedIssue` hangs off `Finding`, not a side table.** Findings are
  already persisted and `saveFindings` upserts by id, so recording the issue
  link needed no `Store` change.
- **Jira failures never reach the gate.** Each finding is filed in isolation
  and errors are logged, on top of the `EventBus` already isolating
  subscribers. A Jira outage must not block a promotion or fail a run.
- **Newly filed issues are added to the active sprint, not left in the
  backlog.** A finding that only a human would find by clicking into the
  Backlog tab defeats the point of filing it automatically — it should appear
  where the team is already looking. `JiraClient.findActiveSprintId()`
  resolves the project's board and its active sprint once per run (not once
  per finding, since it's the same answer for the whole batch and a lookup
  isn't free), and `addToSprint()` places each newly *created* issue there.
  Deliberately skipped on the recurrence path (commenting on an
  already-filed issue): if someone already triaged, assigned, or started it,
  a repeat finding shouldn't yank it back onto the current sprint. A missing
  board (no Scrum board on the project) or no active sprint (Kanban, or
  between sprints) degrades to the pre-existing behavior — filed to the
  backlog, nothing breaks — rather than failing the finding.
- **Cross-sink notification goes through a new event, not a direct call.**
  Slack posting when Jira files an issue could have been `JiraReporter`
  importing `SlackNotifier` and calling it after `createIssue`, but that
  breaks the rule in `project-context.md`'s "Integration pattern (decided)"
  that sinks never call each other. Instead `JiraReporter` emits
  `finding.tracked` on the `EventBus` (provider-agnostic: the event only
  needs `finding.trackedIssue` to be set, so a future non-Jira tracker sink
  emits the same event and Slack's subscription needs no changes), and
  `SlackNotifier` subscribes to it exactly like `run.finished`. Neither
  module imports the other. Only fires for a genuinely new issue, mirroring
  the sprint-placement decision above — a recurrence already got its
  moment when the issue was first filed.
- **This posts in addition to, not instead of, the run report.** A run that
  finishes with new findings now sends two Slack messages seconds apart: the
  full run report (`run.finished`) and one "new issue filed" ping per new
  issue (`finding.tracked`). Fine for the current volume (a handful of
  findings per run at most), but a run with many new P0s would send that
  many separate messages. Revisit if it gets noisy — see Hardening.

## 4. Jira as agent context (the valuable half)

Today `ChangeContext.jiraKeys` records *which* tickets are in a deployment
but nothing reads them. Fetching their contents turns the tracker into an
oracle: the fleet can check whether the deployed change actually does what
the ticket said it would, which sits between team-authored invariants and
free-form LLM judgment in the oracle hierarchy in `project-context.md`.

- [ ] `JiraIssueRef` in shared-types: key, summary, description, issue type,
      status, labels, parent/epic, url, and `acceptanceCriteria`.
- [ ] `JiraClient.getIssue(key)` against
      `GET /rest/api/3/issue/{key}?fields=summary,description,issuetype,status,labels,parent`.
- [ ] ADF → plain text flattener. v3 returns descriptions as ADF, so agents
      cannot read them raw. (`/rest/api/2/issue/{key}` returns a plain string
      and may be the shortcut.)
- [ ] Acceptance criteria: a custom field (`customfield_10xxx`) in most
      company-managed projects, and just a heading in the description
      elsewhere. Default to parsing an "Acceptance criteria" heading out of
      the description; make the field id configurable for teams that have one.
- [ ] Load them in `RunService.startRun` next to the manifest load, as its
      own run step ("Load Jira tickets"), cached per key. Failures must never
      block a run, exactly like a missing manifest.
- [ ] Add to `ChangeContext.jiraIssues` so they flow through `RunContext` and
      into every agent's `ContextBundle`.
- [ ] Show them on the run page and the GitHub check summary ("3 tickets
      under test").

Open question worth settling before building this: acceptance criteria are
written for humans and are frequently stale or absent. Decide whether a
missing/thin ticket is silently ignored (leaning yes) or surfaced as a
coverage gap on the run.

## 5. Link findings to the change that caused them

- [ ] `triage.suspectedPrNumber` → that PR's Jira keys → link the filed issue
      to the ticket with `POST /rest/api/3/issueLink` (type `Relates` or
      `Blocks`). Needs the issue link types available on the site.
- [ ] Remote link back to the finding page via
      `POST /rest/api/3/issue/{key}/remotelink`, so the QA UI shows up in the
      issue's Web Links panel rather than only as a URL in the description.
- [ ] Attach screenshots as real attachments
      (`POST /rest/api/3/issue/{key}/attachments`, needs
      `X-Atlassian-Token: no-check`) once evidence has durable storage. Until
      then `Evidence.content` for screenshots is a path, not a URL, and the
      description just links it.

## 6. Inbound: Jira driving the pipeline (needs a public HTTPS endpoint)

Same tradeoff that cut Slack's slash commands from its MVP.

- [ ] Jira webhook (Settings → System → Webhooks; admin only, available on
      free) for `jira:issue_updated`, filtered by JQL to the QA project.
- [ ] Transitioning a filed issue to Done → set the finding's status to
      `dismissed` or `confirmed` so the QA UI and the tracker stop disagreeing.
- [ ] The web "Dismiss" button (`PATCH /api/findings/:id`, still unbuilt)
      should transition the Jira issue in the same request, so dismissal works
      from either side.
- [ ] Smart Commits (`QA-12 #comment`, `#close`) are a cheaper alternative to
      webhooks for the close direction and need no public URL, but only work
      on branch/commit text.

## 7. Multi-tenant Jira (required before customers can install it)

Current wiring is single-site: one token, one project, from env.

- [ ] Per-repository project key. The QA manifest is the natural home — it is
      team-owned and versioned with the code — as a `jira:` block
      (`project`, `issueType`, `minSeverity`). Falls back to env.
      Requires a manifest schema bump in `src/manifest/load.ts` and
      `docs/qa-manifest.md`.
- [ ] OAuth 2.0 (3LO) instead of a personal API token, so issues are filed by
      an app rather than one person's account. This is inbound (Atlassian
      redirects to a callback), so it needs a public URL.
- [ ] Store `{ cloudId, accessToken, refreshToken, site }` per tenant and
      resolve the client from the run's repository. Cache clients per site.
- [ ] Keep the env-var path as single-site mode for self-hosted and local.
- [ ] Jira Data Center / Server: different auth (PAT) and no `/rest/api/3`.
      Out of scope until a tenant asks.

## 8. Hardening

- [ ] Cap issues filed per run (~20) and fold the remainder into one summary
      issue. A 100-agent run on a badly broken build could otherwise dump
      hundreds of issues into a backlog.
- [ ] Fold multiple `finding.tracked` pings from the same run into one Slack
      message ("3 new issues filed: SCRUM-40, SCRUM-41, SCRUM-42") instead of
      one message per issue, once the same run regularly files more than a
      couple. Today's per-issue message (see Decisions §3) is fine at current
      volume but doesn't scale with the cap above.
- [ ] Retry on 429 honouring `Retry-After`. Atlassian rate limits are
      cost-based and tighter on free; the current client does not retry at all.
- [ ] Throttle concurrent creates. Findings are filed sequentially today,
      which is slow but safe; revisit only if runs get large.
- [ ] Decide whether filing should be gated on `verdict === "block"`. Today a
      passing run still files P0/P1 findings, which is the right default only
      if the gate's severity threshold and `JIRA_MIN_SEVERITY` agree.
- [ ] Tests: `extractJiraKeys` (including the `UTF-8` false positives),
      `dedupeLabel` sanitising, ADF shape, and reporter filtering. There is
      still no `test` script in `packages/control-plane/package.json`.
- [ ] Secret handling: `JIRA_API_TOKEN` sits in `.env` next to the GitHub
      private key and Slack token. Same secrets-manager story as those.

## 9. Documentation

- [ ] Add a "Jira" section to the root `README.md` mirroring section 1.
- [ ] Document the `jira:` manifest block in `docs/qa-manifest.md` once §7
      lands.
