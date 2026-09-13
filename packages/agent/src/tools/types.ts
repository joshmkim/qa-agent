import type { ActionKind, ActionStep, ContextBundle, Finding } from "@qa-agent/shared-types";
import type { BrowserSession, Screenshot } from "../browser/session";
import type { ToolSchema } from "../model/types";

/** What a tool hands back. `content` is exactly what the model reads. */
export interface ToolResult {
  ok: boolean;
  content: string;
  /** The primary path failed but a fallback succeeded; recorded in the trace. */
  recovered?: boolean;
  /** Attach a screenshot the model should see with this result. */
  screenshot?: Screenshot;
  /** Set by `done`; ends the exploration loop. */
  done?: boolean;
}

/** Mutable per-agent state shared by every tool. */
export interface AgentState {
  trace: ActionStep[];
  findings: Finding[];
  visitedSurfaceIds: Set<string>;
  checkedInvariantIds: Set<string>;
  /** Last screenshot id, attached to findings as evidence. */
  lastScreenshotId?: string;
}

export interface ToolContext {
  session: BrowserSession;
  bundle: ContextBundle;
  state: AgentState;
  log: (msg: string) => void;
}

export type ToolArgs = Record<string, unknown>;

export interface ToolDefinition {
  name: ActionKind;
  description: string;
  inputSchema: ToolSchema["inputSchema"];
  /** One-line human description for the action trace. */
  describe(args: ToolArgs): string;
  execute(args: ToolArgs, ctx: ToolContext): Promise<ToolResult>;
}

// --- small arg helpers; tools validate at the boundary and fail structured ---

export function str(args: ToolArgs, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function requireStr(args: ToolArgs, key: string): string {
  const v = str(args, key);
  if (v === undefined) throw new ToolInputError(`Missing required string argument "${key}"`);
  return v;
}

export function num(args: ToolArgs, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function bool(args: ToolArgs, key: string, fallback: boolean): boolean {
  const v = args[key];
  return typeof v === "boolean" ? v : fallback;
}

export function strList(args: ToolArgs, key: string): string[] {
  const v = args[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return [v];
  return [];
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function fail(content: string): ToolResult {
  return { ok: false, content };
}

export function ok(content: string, extra: Omit<ToolResult, "ok" | "content"> = {}): ToolResult {
  return { ok: true, content, ...extra };
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [truncated ${s.length - max} chars]`;
}
