import type { AgentResult, ContextBundle } from "@qa-agent/shared-types";
import { BrowserSession, type BrowserSessionOptions } from "./browser/session";
import { ExplorationLoop, type LoopOptions } from "./loop";
import { AnthropicModelClient } from "./model/anthropic";
import type { ModelClient } from "./model/types";
import { ToolRegistry } from "./tools/registry";
import type { AgentState, ToolContext, ToolDefinition } from "./tools/types";

export type { ModelClient, ModelMessage, ModelRequest, ModelResponse, ToolCall, ToolSchema } from "./model/types";
export { AnthropicModelClient, DEFAULT_MODEL } from "./model/anthropic";
export { BrowserSession } from "./browser/session";
export { ToolRegistry } from "./tools/registry";
export type { ToolDefinition, ToolResult, ToolContext, AgentState } from "./tools/types";
export { buildSystemPrompt, renderChange, renderProduct } from "./prompt";
export { dedupeKey, normalizeSignature } from "./findings";
export { guessSurface } from "./loop";

export interface RunAgentOptions extends LoopOptions {
  /** Defaults to AnthropicModelClient from env (ANTHROPIC_API_KEY, AGENT_MODEL). */
  model?: ModelClient;
  headless?: boolean;
  screenshotDir?: string;
  /** Team-authored semantic actions (login_as, add_item_to_cart, ...). */
  extraTools?: ToolDefinition[];
  /** Headers on every browser request, e.g. a preprod bypass token resolved from credentialsRef. */
  extraHTTPHeaders?: Record<string, string>;
  /** Record a .webm of the whole session (AGENT_RECORD_VIDEO=true). Path lands on AgentResult.videoPath. */
  recordVideo?: boolean;
  /** Called once the browser is up, before the loop starts (e.g. to log in). */
  prepare?: (session: BrowserSession) => Promise<void>;
}

/**
 * Run one agent to completion. Never throws for in-session failures: those
 * come back as status "failed" with `error`. Only setup errors (browser
 * won't launch) propagate.
 */
export async function runAgent(bundle: ContextBundle, opts: RunAgentOptions = {}): Promise<AgentResult> {
  const log = opts.log ?? ((msg: string) => console.log(`[agent ${bundle.agentId}] ${msg}`));
  const model = opts.model ?? new AnthropicModelClient();
  const sessionOpts: BrowserSessionOptions = {
    baseUrl: bundle.environment.baseUrl,
    headless: opts.headless ?? process.env.AGENT_HEADLESS !== "false",
    blastRadiusBoundaries: bundle.environment.blastRadiusBoundaries,
    screenshotDir: opts.screenshotDir,
    extraHTTPHeaders: opts.extraHTTPHeaders,
    recordVideo: opts.recordVideo ?? process.env.AGENT_RECORD_VIDEO === "true",
  };

  const session = await BrowserSession.launch(sessionOpts);
  const state: AgentState = {
    trace: [],
    findings: [],
    visitedSurfaceIds: new Set(),
    checkedInvariantIds: new Set(),
  };
  const ctx: ToolContext = { session, bundle, state, log };
  const registry = new ToolRegistry(opts.extraTools);

  let result: AgentResult | undefined;
  try {
    if (opts.prepare) await opts.prepare(session);
    log(`starting as ${bundle.persona.name} (${bundle.persona.disposition}) with ${model.name}, budget ${bundle.budgetSeconds}s${sessionOpts.recordVideo ? ", recording video" : ""}`);
    const loop = new ExplorationLoop(bundle, model, registry, ctx, { ...opts, log });
    result = await loop.run();
    log(`finished: ${result.status}, ${result.findings.length} findings, ${result.trace.length} steps, ${result.modelCalls} model calls`);
  } finally {
    const { videoPath } = await session.close();
    if (result && videoPath) {
      result.videoPath = videoPath;
      log(`video: ${videoPath}`);
    }
  }
  return result;
}
