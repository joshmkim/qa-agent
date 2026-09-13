import type { ActionStep, Finding } from "./finding";

/**
 * Agent -> orchestrator, once per agent. Findings are the payload that
 * matters; the rest lets the orchestrator compute coverage, steer later
 * agents away from saturated surfaces, and summarize the fleet.
 */
export interface AgentResult {
  runId: string;
  agentId: string;
  /** "completed" includes budget exhaustion; "failed" is an infra failure. */
  status: "completed" | "failed";
  /** Set when status === "failed". */
  error?: string;
  findings: Finding[];
  /** Every tool call the agent made, in order. */
  trace: ActionStep[];
  /** Surface ids the agent reported visiting (from the manifest). */
  visitedSurfaceIds: string[];
  /** Invariant ids the agent explicitly evaluated, violated or not. */
  checkedInvariantIds: string[];
  /** Model round trips, useful for cost accounting. */
  modelCalls: number;
  startedAt: string; // ISO-8601
  finishedAt: string; // ISO-8601
}
