/**
 * Loads the web fixtures into a local control plane started with DEV_SEED=true,
 * plus one in-flight run (beta #48) so polling and findings ingestion have
 * something live to act on.
 *
 *   pnpm --filter @qa-agent/web seed
 */
import type { Run, Stage } from "@qa-agent/shared-types";
import { findings } from "../src/lib/mock/findings";
import { manifestSnapshot, repository, stages } from "../src/lib/mock/pipeline";
import { runBeta47, runs } from "../src/lib/mock/runs";

const baseUrl = (process.env.CONTROL_PLANE_URL ?? "http://localhost:3001").replace(/\/$/, "");

const now = Date.now();
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const liveHeadSha = "5e1a9c3b7d2f4e6a8b0c1d3e5f7a9b2c4d6e8f01";

const runBeta48: Run = {
  ...runBeta47,
  id: "run_beta_48",
  number: 48,
  status: "exploring",
  verdict: "pending",
  confidenceStatement: undefined,
  confidenceScore: undefined,
  change: {
    ...runBeta47.change,
    baseSha: runBeta47.change.headSha,
    headSha: liveHeadSha,
    commitCount: 1,
    filesChanged: 3,
    pullRequests: [],
  },
  steps: [
    { id: "st_deploy", name: "Deployment detected", status: "succeeded", startedAt: minutesAgo(20), finishedAt: minutesAgo(20), detail: "push webhook on stage branch" },
    { id: "st_context", name: "Assemble context", status: "succeeded", startedAt: minutesAgo(20), finishedAt: minutesAgo(18), detail: "diff + PR enrichment + manifest" },
    { id: "st_fleet", name: "Fleet exploration", status: "running", startedAt: minutesAgo(18) },
    { id: "st_triage", name: "Triage & reproduce", status: "pending" },
    { id: "st_gate", name: "Publish check run", status: "pending" },
  ],
  fleet: { ...runBeta47.fleet, agentsCompleted: 37, agentsFailed: 0, totalActions: 6_120 },
  findings: { bySeverity: { P0: 0, P1: 0, P2: 0, P3: 0 }, total: 0, duplicatesCollapsed: 0 },
  checkRunId: undefined,
  startedAt: minutesAgo(20),
  finishedAt: undefined,
};

// The beta cursor advanced when #48 started.
const seededStages: Stage[] = stages.map((s) =>
  s.id === runBeta48.stageId ? { ...s, cursor: { sha: liveHeadSha, updatedAt: runBeta48.startedAt } } : s,
);

// Every fixture run used the fixture manifest at its own head commit.
const allRuns = [...runs, runBeta48].map((run) => ({
  ...run,
  manifest: {
    path: manifestSnapshot.path,
    commitSha: run.change.headSha,
    status: manifestSnapshot.status,
    loadedAt: run.startedAt,
    version: manifestSnapshot.product?.manifestVersion,
  },
}));
const manifests = [...new Set(allRuns.map((r) => r.change.headSha))].map((commitSha) => ({
  repositoryId: repository.id,
  snapshot: { ...manifestSnapshot, commitSha },
}));

const body = {
  installations: [
    {
      installationId: repository.installationId,
      accountLogin: repository.owner,
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
      installedAt: "2026-06-02T09:00:00Z",
    },
  ],
  repositories: [repository],
  stages: seededStages,
  runs: allRuns,
  findings,
  manifests,
};

async function main() {
  const res = await fetch(`${baseUrl}/dev/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Seed failed: ${res.status} ${await res.text()}`);
    console.error("Is the control plane running with DEV_SEED=true?");
    process.exit(1);
  }
  console.log("Seeded", await res.json());
  console.log(`Pipeline: http://localhost:3000/pipelines/${repository.id}`);
}

void main();
