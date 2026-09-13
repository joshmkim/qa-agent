import type { Severity } from "./context-bundle";

export type ActionKind =
  | "navigate"
  | "click"
  | "type"
  | "screenshot"
  | "read_dom"
  | "call_api"
  | "login_as"
  | "add_item_to_cart"
  | "get_logs"
  | "get_metrics"
  | "query_db"
  | "assert";

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

export type EvidenceKind = "screenshot" | "log" | "network" | "metric" | "db";

export interface Evidence {
  id: string;
  kind: EvidenceKind;
  label: string;
  /** For screenshots: URL. For logs/network: raw text excerpt. */
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

/** Agent -> orchestrator. Structured, machine-dedupable. */
export interface Finding {
  id: string;
  runId: string;
  agentId: string;
  personaName: string;
  severity: Severity;
  title: string;
  summary: string;
  /** Surface id from the manifest this finding is attached to. */
  surfaceId: string;
  oracle: OracleSource;
  /** Set when oracle === "invariant". */
  invariantId?: string;
  /** Stable hash of (surface, error signature) used by triage to dedupe. */
  dedupeKey: string;
  reproSteps: ActionStep[];
  evidence: Evidence[];
  status: FindingStatus;
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
