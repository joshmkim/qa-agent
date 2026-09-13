import type { ActionStep } from "@qa-agent/shared-types";
import type { ToolSchema } from "../model/types";
import { OBSERVATION_TOOLS } from "./observe";
import { PRIMITIVE_TOOLS } from "./primitives";
import { REPORTING_TOOLS } from "./report";
import { ToolInputError, truncate, type ToolArgs, type ToolContext, type ToolDefinition, type ToolResult } from "./types";

/** Hard ceiling per tool call so a hung page can't eat the whole budget. */
const TOOL_TIMEOUT_MS = 45_000;

export interface DispatchOutcome {
  result: ToolResult;
  step: ActionStep;
}

/**
 * The agent's toolbox. Semantic actions (team-authored composites like
 * login_as) plug in through `extra`; they use the same ToolDefinition shape.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(extra: ToolDefinition[] = []) {
    for (const t of [...PRIMITIVE_TOOLS, ...OBSERVATION_TOOLS, ...REPORTING_TOOLS, ...extra]) {
      this.tools.set(t.name, t);
    }
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Run one tool call, record it in the trace, and never throw: every
   * failure comes back as a structured ToolResult the model can act on.
   */
  async dispatch(name: string, args: ToolArgs, ctx: ToolContext): Promise<DispatchOutcome> {
    const tool = this.tools.get(name);
    const startedAt = Date.now();
    const index = ctx.state.trace.length;

    if (!tool) {
      const result: ToolResult = { ok: false, content: `Unknown tool "${name}". Available: ${this.names().join(", ")}` };
      const step = this.record(ctx, index, "assert", `Unknown tool ${name}`, args, result, startedAt);
      return { result, step };
    }

    let result: ToolResult;
    try {
      result = await withTimeout(tool.execute(args, ctx), TOOL_TIMEOUT_MS, `${name} exceeded ${TOOL_TIMEOUT_MS / 1000}s`);
    } catch (err) {
      if (err instanceof ToolInputError) {
        result = { ok: false, content: `Invalid arguments for ${name}: ${err.message}` };
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        result = {
          ok: false,
          content: `${name} failed unexpectedly: ${truncate(msg, 400)}. The page may have navigated or closed; call read_dom to re-orient.`,
        };
      }
    }
    const step = this.record(ctx, index, tool.name, safeDescribe(tool, args), args, result, startedAt);
    return { result, step };
  }

  private record(
    ctx: ToolContext,
    index: number,
    kind: ActionStep["kind"],
    description: string,
    args: ToolArgs,
    result: ToolResult,
    startedAt: number,
  ): ActionStep {
    const step: ActionStep = {
      index,
      kind,
      description,
      args: flattenArgs(args),
      outcome: result.ok ? (result.recovered ? "recovered" : "ok") : "failed",
      durationMs: Date.now() - startedAt,
      ...(result.screenshot ? { screenshotId: result.screenshot.id } : {}),
    };
    ctx.state.trace.push(step);
    return step;
  }
}

function safeDescribe(tool: ToolDefinition, args: ToolArgs): string {
  try {
    return tool.describe(args);
  } catch {
    return tool.name;
  }
}

/** ActionStep.args is flat; nested values are JSON-encoded. */
function flattenArgs(args: ToolArgs): ActionStep["args"] {
  const out: ActionStep["args"] = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else out[k] = JSON.stringify(v);
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
