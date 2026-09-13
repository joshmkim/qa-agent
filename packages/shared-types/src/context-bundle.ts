/** A GitHub pull request that landed in the change window. */
export interface PullRequestRef {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  linkedIssues: string[];
  url: string;
  mergedAt: string; // ISO-8601
  filesChanged: number;
  additions: number;
  deletions: number;
}

/** One file in the compare window. */
export interface ChangedFile {
  path: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  /**
   * Unified diff hunk for this file, as returned by the compare API. Absent
   * for binary files and for files GitHub considers too large to diff. This
   * is what gives agents the actual code change, not just the file list.
   */
  patch?: string;
}

/** Diff between last deployed cursor and current head, enriched with PRs. */
export interface ChangeContext {
  baseSha: string;
  headSha: string;
  commitCount: number;
  filesChanged: number;
  pullRequests: PullRequestRef[];
  /**
   * Compare API status; "diverged" means we fell back to merge base.
   * "unavailable" means the compare failed and the run never got a diff.
   */
  compareStatus: "ahead" | "behind" | "identical" | "diverged" | "unavailable";
  /** Files from the compare, used to mark surfaces touched by the change. */
  changedFiles?: ChangedFile[];
  /** True when GitHub capped the compare file list (300 files). */
  filesTruncated?: boolean;
}

export type SurfaceKind = "page" | "form" | "button" | "endpoint" | "flow";

/** One entry in the team-owned QA manifest surface inventory. */
export interface Surface {
  id: string;
  kind: SurfaceKind;
  name: string;
  /** Route, selector, or endpoint path depending on kind. */
  locator: string;
  description?: string;
  /** Surfaces touched by files in the change window get priority. */
  touchedByChange?: boolean;
}

/** A team-authored invariant. Highest-leverage artifact in the manifest. */
export interface Invariant {
  id: string;
  statement: string;
  /** Optional machine-checkable expression the judge can evaluate. */
  check?: string;
  severityOnViolation: Severity;
}

export interface ProductContext {
  productName: string;
  intent: string;
  stakeholders: string[];
  surfaces: Surface[];
  invariants: Invariant[];
  manifestVersion: string;
}

export interface EnvironmentContext {
  stageName: string;
  baseUrl: string;
  /** Reference into a secrets store, never the credential itself. */
  credentialsRef: string;
  seededDataRef?: string;
  /** Hosts, paths, or actions agents must never touch. */
  blastRadiusBoundaries: string[];
}

export type Disposition =
  | "methodical"
  | "chaos-monkey"
  | "adversarial-fuzzer"
  | "impatient-user";

export interface Persona {
  id: string;
  name: string;
  description: string;
  disposition: Disposition;
  /** Surface ids this agent should prioritize. */
  focusAreas: string[];
}

export type Severity = "P0" | "P1" | "P2" | "P3";

/** Orchestrator -> agent. Everything an agent needs to start exploring. */
export interface ContextBundle {
  runId: string;
  agentId: string;
  persona: Persona;
  change: ChangeContext;
  product: ProductContext;
  environment: EnvironmentContext;
  /** Wall-clock budget for the exploration loop. */
  budgetSeconds: number;
  /** States other agents already saturated; steer away. */
  saturatedSurfaceIds: string[];
}
