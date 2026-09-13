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
  /**
   * Jira issue keys referenced by the PRs and commits in this window, e.g.
   * ["QA-12"]. Only keys whose project prefix is configured are kept, so
   * strings like "UTF-8" never land here.
   */
  jiraKeys?: string[];
  /** Files from the compare, used to mark surfaces touched by the change. */
  changedFiles?: ChangedFile[];
  /** True when GitHub capped the compare file list (300 files). */
  filesTruncated?: boolean;
}

export type SurfaceKind = "page" | "form" | "button" | "endpoint" | "flow";

/** One entry in the team-owned code primitives surface inventory. */
export interface Surface {
  id: string;
  kind: SurfaceKind;
  name: string;
  /** Route, selector, or endpoint path depending on kind. */
  locator: string;
  description?: string;
  /** Repo path globs that implement this surface; used to mark it touched. */
  sources?: string[];
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
  /** Surfaces where this invariant is observable. */
  surfaceIds?: string[];
}

export interface ProductContext {
  productName: string;
  intent: string;
  stakeholders: string[];
  surfaces: Surface[];
  invariants: Invariant[];
  /** Short blob SHA of the manifest file; changes only when the manifest does. */
  manifestVersion: string;
  /** Things agents must never do, authored by the team in the manifest. */
  boundaries?: string[];
}

export type ManifestStatus =
  | "loaded"
  | "missing" // no manifest file at that commit
  | "invalid" // file exists but failed validation
  | "error"; // could not be fetched (GitHub error)

/** The code primitives (.qa/manifest.yaml) as read from a repo at one commit. */
export interface ManifestSnapshot {
  path: string;
  commitSha: string;
  status: ManifestStatus;
  /** Present when status is "loaded". Surfaces carry touchedByChange for the run that loaded it. */
  product?: ProductContext;
  /** Validation or fetch errors, path-prefixed where possible. */
  errors?: string[];
  loadedAt: string;
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

/**
 * Everything about a run that every agent shares. The orchestrator adds the
 * per-agent fields (agentId, persona, saturatedSurfaceIds) to make a bundle.
 */
export type RunContext = Omit<ContextBundle, "agentId" | "persona" | "saturatedSurfaceIds">;
