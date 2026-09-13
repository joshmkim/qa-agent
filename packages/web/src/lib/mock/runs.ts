import type { Run, RunStep } from "@qa-agent/shared-types";
import { betaPullRequests, repository } from "./pipeline";

const doneSteps = (start: string, offsetsMin: number[]): RunStep[] => {
  const t0 = new Date(start).getTime();
  const at = (m: number) => new Date(t0 + m * 60_000).toISOString();
  return [
    { id: "st_deploy", name: "Deployment detected", status: "succeeded", startedAt: at(0), finishedAt: at(0), detail: "push webhook on stage branch" },
    { id: "st_context", name: "Assemble context", status: "succeeded", startedAt: at(0), finishedAt: at(offsetsMin[0]), detail: "diff + PR enrichment + code primitives" },
    { id: "st_fleet", name: "Fleet exploration", status: "succeeded", startedAt: at(offsetsMin[0]), finishedAt: at(offsetsMin[1]) },
    { id: "st_triage", name: "Triage & reproduce", status: "succeeded", startedAt: at(offsetsMin[1]), finishedAt: at(offsetsMin[2]) },
    { id: "st_gate", name: "Publish check run", status: "succeeded", startedAt: at(offsetsMin[2]), finishedAt: at(offsetsMin[2] + 1) },
  ];
};

export const runBeta47: Run = {
  id: "run_beta_47",
  repositoryId: repository.id,
  stageId: "stage_beta",
  number: 47,
  status: "blocked",
  verdict: "block",
  confidenceStatement:
    "Low confidence to promote. 2 P0 regressions reproduced in checkout, both introduced by #1482 (single-page checkout). 91% of changed surfaces covered by 100 agents; the remaining gap is the non-US address path, which 3 agents attempted but could not complete because of the P0.",
  confidenceScore: 0.31,
  trigger: "push-webhook",
  change: {
    baseSha: "4b7e0d19c2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7",
    headSha: "9f3c1e2a7b4d5f6081a2b3c4d5e6f70819a2b3c4",
    commitCount: 23,
    filesChanged: 67,
    pullRequests: betaPullRequests,
    compareStatus: "ahead",
  },
  steps: doneSteps("2026-09-13T15:42:10Z", [2, 38, 51]),
  fleet: {
    agentsRequested: 100,
    agentsCompleted: 97,
    agentsFailed: 3,
    dispositions: { methodical: 40, "chaos-monkey": 25, "adversarial-fuzzer": 20, "impatient-user": 15 },
    totalActions: 18_432,
  },
  coverage: {
    surfacesTotal: 16,
    surfacesVisited: 15,
    changedSurfacesTotal: 11,
    changedSurfacesVisited: 10,
    invariantsTotal: 6,
    invariantsChecked: 6,
  },
  findings: {
    bySeverity: { P0: 2, P1: 1, P2: 3, P3: 2 },
    total: 8,
    duplicatesCollapsed: 41,
  },
  checkRunId: 31877345120,
  startedAt: "2026-09-13T15:42:10Z",
  finishedAt: "2026-09-13T16:34:02Z",
};

export const runBeta46: Run = {
  id: "run_beta_46",
  repositoryId: repository.id,
  stageId: "stage_beta",
  number: 46,
  status: "passed",
  verdict: "pass",
  confidenceStatement:
    "High confidence to promote. No P0/P1 findings. 100% of changed surfaces covered. 1 P3 cosmetic finding on the wishlist empty state.",
  confidenceScore: 0.93,
  trigger: "push-webhook",
  change: {
    baseSha: "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9",
    headSha: "4b7e0d19c2a3f4e5d6c7b8a9f0e1d2c3b4a5f6e7",
    commitCount: 9,
    filesChanged: 21,
    pullRequests: [
      {
        number: 1471,
        title: "feat(wishlist): share wishlist by link",
        body: "Adds public share links for wishlists.",
        author: "aokafor",
        labels: ["wishlist", "feature"],
        linkedIssues: ["#1350"],
        url: "https://github.com/acme/storefront/pull/1471",
        mergedAt: "2026-09-12T20:55:00Z",
        filesChanged: 14,
        additions: 380,
        deletions: 22,
      },
      {
        number: 1469,
        title: "fix(pdp): image gallery keyboard navigation",
        body: "Arrow keys now move between thumbnails.",
        author: "tchen",
        labels: ["pdp", "a11y"],
        linkedIssues: [],
        url: "https://github.com/acme/storefront/pull/1469",
        mergedAt: "2026-09-12T18:12:40Z",
        filesChanged: 7,
        additions: 96,
        deletions: 31,
      },
    ],
    compareStatus: "ahead",
  },
  steps: doneSteps("2026-09-12T21:08:44Z", [2, 33, 41]),
  fleet: {
    agentsRequested: 100,
    agentsCompleted: 100,
    agentsFailed: 0,
    dispositions: { methodical: 40, "chaos-monkey": 25, "adversarial-fuzzer": 20, "impatient-user": 15 },
    totalActions: 16_902,
  },
  coverage: {
    surfacesTotal: 16,
    surfacesVisited: 16,
    changedSurfacesTotal: 4,
    changedSurfacesVisited: 4,
    invariantsTotal: 6,
    invariantsChecked: 6,
  },
  findings: {
    bySeverity: { P0: 0, P1: 0, P2: 0, P3: 1 },
    total: 1,
    duplicatesCollapsed: 3,
  },
  checkRunId: 31861002218,
  startedAt: "2026-09-12T21:08:44Z",
  finishedAt: "2026-09-12T21:50:30Z",
};

export const runBeta45: Run = {
  ...runBeta46,
  id: "run_beta_45",
  number: 45,
  status: "passed",
  verdict: "override",
  confidenceStatement:
    "Medium confidence. 1 P1 finding (promo code case sensitivity) reproduced; team overrode the gate with a follow-up ticket.",
  confidenceScore: 0.72,
  trigger: "api",
  triggeredBy: "ci/deploy-beta",
  change: {
    ...runBeta46.change,
    baseSha: "77e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6",
    headSha: "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9",
    commitCount: 5,
    filesChanged: 12,
    pullRequests: [],
  },
  steps: doneSteps("2026-09-11T19:20:00Z", [3, 36, 44]),
  findings: {
    bySeverity: { P0: 0, P1: 1, P2: 1, P3: 0 },
    total: 2,
    duplicatesCollapsed: 7,
  },
  checkRunId: 31840871100,
  startedAt: "2026-09-11T19:20:00Z",
  finishedAt: "2026-09-11T20:05:12Z",
};

export const runGamma31: Run = {
  id: "run_gamma_31",
  repositoryId: repository.id,
  stageId: "stage_gamma",
  number: 31,
  status: "passed",
  verdict: "pass",
  confidenceStatement:
    "High confidence to promote. Wishlist sharing and PDP gallery changes exercised end-to-end by 60 agents. No findings above P3.",
  confidenceScore: 0.95,
  trigger: "push-webhook",
  change: runBeta46.change,
  steps: doneSteps("2026-09-12T22:30:00Z", [2, 29, 36]),
  fleet: {
    agentsRequested: 60,
    agentsCompleted: 60,
    agentsFailed: 0,
    dispositions: { methodical: 30, "chaos-monkey": 10, "adversarial-fuzzer": 10, "impatient-user": 10 },
    totalActions: 9_804,
  },
  coverage: {
    surfacesTotal: 16,
    surfacesVisited: 16,
    changedSurfacesTotal: 4,
    changedSurfacesVisited: 4,
    invariantsTotal: 6,
    invariantsChecked: 6,
  },
  findings: {
    bySeverity: { P0: 0, P1: 0, P2: 0, P3: 1 },
    total: 1,
    duplicatesCollapsed: 2,
  },
  checkRunId: 31862440917,
  startedAt: "2026-09-12T22:30:00Z",
  finishedAt: "2026-09-12T23:07:44Z",
};

export const runProd12: Run = {
  id: "run_prod_12",
  repositoryId: repository.id,
  stageId: "stage_prod",
  number: 12,
  status: "passed",
  verdict: "pass",
  confidenceStatement:
    "Smoke fleet (20 agents) completed with no findings. Production monitoring only; this stage does not gate promotion.",
  confidenceScore: 0.97,
  trigger: "push-webhook",
  change: {
    baseSha: "33a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
    headSha: "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0",
    commitCount: 4,
    filesChanged: 9,
    pullRequests: [],
    compareStatus: "ahead",
  },
  steps: doneSteps("2026-09-11T17:30:02Z", [2, 14, 18]),
  fleet: {
    agentsRequested: 20,
    agentsCompleted: 20,
    agentsFailed: 0,
    dispositions: { methodical: 20 },
    totalActions: 2_311,
  },
  coverage: {
    surfacesTotal: 16,
    surfacesVisited: 12,
    changedSurfacesTotal: 2,
    changedSurfacesVisited: 2,
    invariantsTotal: 6,
    invariantsChecked: 5,
  },
  findings: {
    bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 },
    total: 0,
    duplicatesCollapsed: 0,
  },
  checkRunId: 31822109331,
  startedAt: "2026-09-11T17:30:02Z",
  finishedAt: "2026-09-11T17:49:20Z",
};

export const runs: Run[] = [runBeta47, runBeta46, runBeta45, runGamma31, runProd12];
