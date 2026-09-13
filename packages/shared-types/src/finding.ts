import type { Severity } from "./context-bundle";

export type ActionKind =
  // browser primitives
  | "navigate"
  | "click"
  | "type"
  | "press_key"
  | "select_option"
  | "scroll"
  | "wait_for"
  | "go_back"
  | "screenshot"
  | "read_dom"
  | "read_text"
  | "call_api"
  // team-authored semantic actions
  | "login_as"
  | "add_item_to_cart"
  // observation
  | "get_console_errors"
  | "get_network_failures"
  | "get_logs"
  | "get_metrics"
  | "query_db"
  // reporting
  | "assert"
  | "check_invariant"
  | "mark_surface_visited"
  | "file_finding"
  | "done";

/** One replayable step in an agent's action trace. */
export interface ActionStep {
  index: number;
  kind: ActionKind;
  /** Human-readable description of what the agent did. */
  description: string;
  /** Tool arguments, e.g. { selector: "#checkout" } or { url: "/cart" }. */
  args: Record<string, string | number | boolean>;
  /** Structured result or failure from the tool. */
  outcome: "ok" | "failed" | "recovered";
  durationMs: number;
  /** Optional screenshot id captured after this step. */
  screenshotId?: string;
}

export type EvidenceKind = "screenshot" | "video" | "log" | "network" | "metric" | "db";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  /**
   * For screenshots/videos: a URL the web can load (the control-plane's
   * /api/artifacts route when run by the orchestrator; a local path only in
   * standalone runs). For logs/network: raw text excerpt.
   */
  content: string;
  capturedAt: string; // ISO-8601
}

/** How the oracle decided this was a bug. */
export type OracleSource =
  | "hard-error" // 5xx, uncaught exception, crash: free
  | "invariant" // team-authored invariant violated
  | "llm-judgment"; // judged against product description

export type FindingStatus =
  | "new"
  | "reproduced"
  | "duplicate"
  | "dismissed"
  | "confirmed";

/** An issue filed in an external tracker for a finding. */
export interface TrackedIssue {
  provider: "jira";
  /** Issue key, e.g. "QA-42". */
  key: string;
  url: string;
  filedAt: string; // ISO-8601
}

/** Agent -> orchestrator. Structured, machine-dedupable. */
export interface Finding {
  id: string;
  runId: string;
  agentId: string;
  personaName: string;
  severity: Severity;
  title: string;
  summary: string;
  /** Surface id from the code primitives this finding is attached to. */
  surfaceId: string;
  oracle: OracleSource;
  /** Set when oracle === "invariant". */
  invariantId?: string;
  /** Stable hash of (surface, error signature) used by triage to dedupe. */
  dedupeKey: string;
  reproSteps: ActionStep[];
  evidence: Evidence[];
  status: FindingStatus;
  /** Set once this finding has been filed in an external tracker. */
  trackedIssue?: TrackedIssue;
  /** Populated by the triage judge. */
  triage?: {
    reproducedFromCleanSession: boolean;
    duplicateOf?: string;
    duplicateCount: number;
    /** Best-effort attribution to the PR that introduced the regression. */
    suspectedPrNumber?: number;
    note?: string;
  };
  reportedAt: string; // ISO-8601
}
