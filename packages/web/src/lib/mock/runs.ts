import type { Run, RunStep } from "@qa-agent/shared-types";
import { betaPullRequests, betaPullRequestsRun1, repository, SHA } from "./pipeline";

const doneSteps = (start: string, offsetsMin: number[], fleetDetail: string): RunStep[] => {
  const t0 = new Date(start).getTime();
  const at = (m: number) => new Date(t0 + m * 60_000).toISOString();
  return [
    { id: "st_deploy", name: "Deployment detected", status: "succeeded", startedAt: at(0), finishedAt: at(0), detail: "push webhook on stage branch" },
    { id: "st_context", name: "Assemble context", status: "succeeded", startedAt: at(0), finishedAt: at(offsetsMin[0]), detail: "diff + PR enrichment + code primitives" },
    { id: "st_fleet", name: "Fleet exploration", status: "succeeded", startedAt: at(offsetsMin[0]), finishedAt: at(offsetsMin[1]), detail: fleetDetail },
    { id: "st_triage", name: "Triage & reproduce", status: "succeeded", startedAt: at(offsetsMin[1]), finishedAt: at(offsetsMin[2]) },
    { id: "st_gate", name: "Publish check run", status: "succeeded", startedAt: at(offsetsMin[2]), finishedAt: at(offsetsMin[2] + 0.2) },
  ];
};

// 10 agents split by the persona mix (40/25/20/15), largest remainder.
const DISPOSITIONS_10 = { methodical: 4, "chaos-monkey": 3, "adversarial-fuzzer": 2, "impatient-user": 1 };

/** Latest beta run: #4 merge -> #7 merge (PRs #5, #6, #7). Anonymous shoppers only. */
export const runBeta2: Run = {
  id: "run_beta_2",
  repositoryId: repository.id,
  stageId: "stage_beta",
  number: 2,
  status: "passed",
  verdict: "pass",
  confidenceStatement:
    "Moderate confidence to promote. 1 P1 issue (core flow degraded). 1 lower-severity finding. 1 of 1 changed surfaces (100%) and 19 of 26 surfaces overall covered by 10 of 10 agents completed (1184 actions). 7 of 10 invariants checked. Run #1's sale-sticker and stock-endpoint findings did not reproduce after the reseed. No test shopper credentials, so signed-in surfaces (profile, favorites, reviews) were not exercised.",
  confidenceScore: 0.85,
  trigger: "push-webhook",
  triggeredBy: "TrentK014",
  change: {
    baseSha: SHA.beta_pr4_merge,
    headSha: SHA.beta_pr7_merge,
    commitCount: 12,
    filesChanged: 8,
    pullRequests: betaPullRequests,
    compareStatus: "ahead",
  },
  steps: doneSteps("2026-09-13T20:56:31Z", [0.3, 8.6, 9.4], "10/10 agents completed, 1184 actions"),
  fleet: {
    agentsRequested: 10,
    agentsCompleted: 10,
    agentsFailed: 0,
    dispositions: DISPOSITIONS_10,
    totalActions: 1_184,
  },
  coverage: {
    surfacesTotal: 26,
    surfacesVisited: 19,
    changedSurfacesTotal: 1,
    changedSurfacesVisited: 1,
    invariantsTotal: 10,
    invariantsChecked: 7,
  },
  findings: {
    bySeverity: { P0: 0, P1: 1, P2: 0, P3: 1 },
    total: 2,
    duplicatesCollapsed: 3,
  },
  manifest: {
    path: ".qa/manifest.yaml",
    commitSha: SHA.beta_pr7_merge,
    status: "loaded",
    loadedAt: "2026-09-13T20:56:32Z",
    version: "1",
  },
  checkRunId: 51407733120,
  startedAt: "2026-09-13T20:56:31Z",
  finishedAt: "2026-09-13T21:06:12Z",
};

/** First beta run after the manifest landed: #3 merge -> #4 merge (PR #4, sale sticker test id). */
export const runBeta1: Run = {
  id: "run_beta_1",
  repositoryId: repository.id,
  stageId: "stage_beta",
  number: 1,
  status: "passed",
  verdict: "pass",
  confidenceStatement:
    "Moderate confidence to promote. 2 P1 issues (core flow degraded). 1 lower-severity finding. 7 of 7 changed surfaces (100%) and 17 of 26 surfaces overall covered by 10 of 10 agents completed (1027 actions). 7 of 10 invariants checked. No test shopper credentials, so signed-in surfaces were not exercised.",
  confidenceScore: 0.67,
  trigger: "push-webhook",
  triggeredBy: "TrentK014",
  change: {
    baseSha: SHA.beta_pr3_merge,
    headSha: SHA.beta_pr4_merge,
    commitCount: 2,
    filesChanged: 1,
    pullRequests: betaPullRequestsRun1,
    compareStatus: "ahead",
  },
  steps: doneSteps("2026-09-13T19:46:48Z", [0.3, 8.1, 8.7], "10/10 agents completed, 1027 actions"),
  fleet: {
    agentsRequested: 10,
    agentsCompleted: 10,
    agentsFailed: 0,
    dispositions: DISPOSITIONS_10,
    totalActions: 1_027,
  },
  coverage: {
    surfacesTotal: 26,
    surfacesVisited: 17,
    // SaleSticker.tsx is a source of the five category pages, sale, shoe-detail and size-selector.
    changedSurfacesTotal: 7,
    changedSurfacesVisited: 7,
    invariantsTotal: 10,
    invariantsChecked: 7,
  },
  findings: {
    bySeverity: { P0: 0, P1: 2, P2: 1, P3: 0 },
    total: 3,
    duplicatesCollapsed: 2,
  },
  manifest: {
    path: ".qa/manifest.yaml",
    commitSha: SHA.beta_pr4_merge,
    status: "loaded",
    loadedAt: "2026-09-13T19:46:49Z",
    version: "1",
  },
  checkRunId: 51404218873,
  startedAt: "2026-09-13T19:46:48Z",
  finishedAt: "2026-09-13T19:55:30Z",
};

export const runs: Run[] = [runBeta2, runBeta1];
