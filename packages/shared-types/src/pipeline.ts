import type { ChangeContext, Severity } from "./context-bundle";

export interface Repository {
  id: string;
  owner: string;
  name: string;
  fullName: string; // owner/name
  defaultBranch: string;
  installationId: number;
  url: string;
}

/**
 * Where a stage last saw a deployment. Advances when a run STARTS.
 * Stores both SHA and PR number so branch-promotion SHA mismatches can
 * still be reconciled by PR identity.
 */
export interface DeployCursor {
  sha: string;
  prNumber?: number;
  updatedAt: string; // ISO-8601
}

export type RunStatus =
  | "queued"
  | "assembling-context"
  | "exploring"
  | "triaging"
  | "passed"
  | "blocked"
  | "failed" // infra failure, not a QA verdict
  | "cancelled";

/** Statuses where the run is still in flight and can change. */
export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "queued",
  "assembling-context",
  "exploring",
  "triaging",
]);

export function isRunActive(run: Pick<Run, "status">): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

export type GateVerdict = "pending" | "pass" | "block" | "override";

/** A named unit of work inside a run, shown as a step card in the UI. */
export interface RunStep {
  id: string;
  name: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

export interface FleetSummary {
  agentsRequested: number;
  agentsCompleted: number;
  agentsFailed: number;
  /** Distribution of dispositions across the fleet. */
  dispositions: Record<string, number>;
  totalActions: number;
}

export interface CoverageSummary {
  surfacesTotal: number;
  surfacesVisited: number;
  /** Surfaces touched by the change and visited by at least one agent. */
  changedSurfacesTotal: number;
  changedSurfacesVisited: number;
  invariantsTotal: number;
  invariantsChecked: number;
}

export interface FindingCounts {
  bySeverity: Record<Severity, number>;
  total: number;
  duplicatesCollapsed: number;
}

/** One QA fleet run against one stage deployment. */
export interface Run {
  id: string;
  repositoryId: string;
  stageId: string;
  /** Monotonic per stage; shown as "Run #42". */
  number: number;
  status: RunStatus;
  verdict: GateVerdict;
  /** Headline confidence statement authored by the triage judge. */
  confidenceStatement?: string;
  /** 0..1 */
  confidenceScore?: number;
  trigger: "push-webhook" | "api" | "manual";
  triggeredBy?: string;
  change: ChangeContext;
  steps: RunStep[];
  fleet: FleetSummary;
  coverage: CoverageSummary;
  findings: FindingCounts;
  /** GitHub check run id once posted. */
  checkRunId?: number;
  startedAt: string;
  finishedAt?: string;
}

/** A pipeline stage mapped to a deployment branch (beta -> `beta`). */
export interface Stage {
  id: string;
  repositoryId: string;
  name: string; // "beta" | "gamma" | "prod" or team-defined
  branch: string;
  /** Stage order left-to-right in the pipeline view. */
  order: number;
  environmentUrl?: string;
  cursor?: DeployCursor;
  /** Whether promotion into the next stage is gated by this stage's run. */
  gatesPromotion: boolean;
  /**
   * Start a QA run automatically when a deployment lands on this branch.
   * When false, deployments are only announced and a human kicks off the run
   * (e.g. from Slack). Defaults to true when unset.
   */
  autoRun?: boolean;
  /** Next stage's branch protected by our check run. */
  protectedBranch?: string;
  fleetSize: number;
  latestRunId?: string;
}

export interface Pipeline {
  id: string;
  repository: Repository;
  name: string;
  stages: Stage[];
  manifestPath: string;
  manifestVersion: string;
  createdAt: string;
}
