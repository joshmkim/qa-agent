import type { AgentResult, ContextBundle, Surface } from "@qa-agent/shared-types";
import type { BrowserSession, ConsoleError, NetworkFailure } from "./browser/session";
import { consoleEvidence, networkEvidence, screenshotEvidence } from "./findings";
import type { ModelClient, ModelMessage, ToolResultMessage } from "./model/types";
import { buildKickoff, buildSystemPrompt, type PromptOptions } from "./prompt";
import type { ToolRegistry } from "./tools/registry";
import { fileFindingInternal } from "./tools/report";
import type { AgentState, ToolContext } from "./tools/types";

export interface LoopOptions extends PromptOptions {
  /** Upper bound on tool calls regardless of time budget. */
  maxSteps?: number;
  /** Tool rounds kept verbatim in history; older results are summarized. */
  keepRecentRounds?: number;
  /** Consecutive model turns without tool calls before we stop. */
  maxIdleTurns?: number;
  onStep?: (step: AgentState["trace"][number], state: AgentState) => void;
  log?: (msg: string) => void;
}

const MODEL_RETRIES = 3;

/**
 * Guess which code primitives surface the page belongs to from its URL, so
 * auto-filed hard errors land on a real surface. Route locators may contain
 * ":param" segments.
 */
export function guessSurface(pageUrl: string, surfaces: Surface[], fallback: string): string {
  let path: string;
  try {
    path = new URL(pageUrl).pathname.replace(/\/+$/, "") || "/";
  } catch {
    return fallback;
  }
  let best: { id: string; score: number } | undefined;
  for (const s of surfaces) {
    if (s.kind !== "page" && s.kind !== "flow") continue;
    const loc = s.locator.replace(/\/+$/, "") || "/";
    if (!loc.startsWith("/")) continue;
    const pattern = new RegExp(`^${loc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\:[a-zA-Z_]+/g, "[^/]+")}$`);
    if (pattern.test(path)) {
      const score = loc.length;
      if (!best || score > best.score) best = { id: s.id, score };
    }
  }
  return best?.id ?? fallback;
}

export class ExplorationLoop {
  private readonly messages: ModelMessage[] = [];
  private modelCalls = 0;
  private warnedBudget = false;
  private idleTurns = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly bundle: ContextBundle,
    private readonly model: ModelClient,
    private readonly registry: ToolRegistry,
    private readonly ctx: ToolContext,
    private readonly opts: LoopOptions = {},
  ) {}

  private get session(): BrowserSession {
    return this.ctx.session;
  }

  private log(msg: string): void {
    (this.opts.log ?? this.ctx.log)(msg);
  }

  private remainingMs(): number {
    return this.bundle.budgetSeconds * 1_000 - (Date.now() - this.startedAt);
  }

  async run(): Promise<AgentResult> {
    const startedAtIso = new Date(this.startedAt).toISOString();
    const system = buildSystemPrompt(this.bundle, this.opts);
    const tools = this.registry.schemas();
    const maxSteps = this.opts.maxSteps ?? 150;
    const maxIdle = this.opts.maxIdleTurns ?? 2;
    this.messages.push({ role: "user", text: buildKickoff(this.bundle) });

    let status: AgentResult["status"] = "completed";
    let error: string | undefined;

    try {
      outer: for (;;) {
        if (this.remainingMs() <= 0) {
          this.log("budget exhausted");
          break;
        }
        if (this.ctx.state.trace.length >= maxSteps) {
          this.log(`max steps (${maxSteps}) reached`);
          break;
        }

        const response = await this.callModel(system, tools);
        this.messages.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });

        if (response.toolCalls.length === 0) {
          this.idleTurns += 1;
          if (this.idleTurns > maxIdle) {
            this.log("model stopped calling tools; ending session");
            break;
          }
          this.messages.push({
            role: "user",
            text: "You must act through tools. Continue exploring with a tool call, or call done(summary) if you are finished.",
          });
          continue;
        }
        this.idleTurns = 0;

        const results: ToolResultMessage[] = [];
        let finished = false;
        for (const call of response.toolCalls) {
          const { result, step } = await this.registry.dispatch(call.name, call.args, this.ctx);
          this.opts.onStep?.(step, this.ctx.state);
          const prefix = this.hardErrorNotice();
          const suffix = this.budgetNotice();
          results.push({
            toolCallId: call.id,
            content: `${prefix}[step ${step.index}] ${result.content}${suffix}`,
            isError: !result.ok,
            imageBase64: result.screenshot?.base64,
          });
          if (result.done) {
            finished = true;
            break;
          }
        }
        this.messages.push({ role: "user", toolResults: results });
        if (finished) break outer;
        this.compactHistory();
      }
    } catch (err) {
      status = "failed";
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.log(`failed: ${error}`);
    }

    // Anything the browser recorded after the last tool call.
    this.autoFileHardErrors(this.session.drainHardErrors());

    const state = this.ctx.state;
    return {
      runId: this.bundle.runId,
      agentId: this.bundle.agentId,
      status,
      ...(error ? { error } : {}),
      findings: state.findings,
      trace: state.trace,
      visitedSurfaceIds: [...state.visitedSurfaceIds],
      checkedInvariantIds: [...state.checkedInvariantIds],
      modelCalls: this.modelCalls,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
    };
  }

  private async callModel(system: string, tools: ReturnType<ToolRegistry["schemas"]>) {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MODEL_RETRIES; attempt++) {
      try {
        this.modelCalls += 1;
        return await this.model.complete({ system, messages: this.messages, tools });
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`model call failed (attempt ${attempt}/${MODEL_RETRIES}): ${msg}`);
        // Context overflow won't fix itself with a retry; compact hard first.
        if (/context|too long|tokens/i.test(msg)) this.compactHistory(2);
        if (attempt < MODEL_RETRIES) await sleep(1_000 * 2 ** (attempt - 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Hard errors recorded since the previous step, auto-filed and announced. */
  private hardErrorNotice(): string {
    const drained = this.session.drainHardErrors();
    if (!drained.console.length && !drained.network.length) return "";
    const filed = this.autoFileHardErrors(drained);
    const lines = [
      ...drained.console.map((e) => `  ${e.kind}: ${e.text.slice(0, 200)}`),
      ...drained.network.map((f) => `  ${f.method} ${f.url} -> ${f.status ?? f.failureText}`),
    ];
    return `Hard errors since last step${filed.length ? ` (auto-filed: ${filed.join(", ")}; add context via file_finding only if you learn the user-visible impact)` : ""}:\n${lines.join("\n")}\n\n`;
  }

  /**
   * Safety net: 5xx, crashes, uncaught exceptions and dead requests become
   * findings even if the model never files them. Dedupe is by signature so
   * a chatty endpoint doesn't produce fifty findings.
   */
  private autoFileHardErrors(drained: { console: ConsoleError[]; network: NetworkFailure[] }): string[] {
    const filed: string[] = [];
    const fallbackSurface = this.bundle.persona.focusAreas[0] ?? this.bundle.product.surfaces[0]?.id ?? "unknown-surface";
    const surfaces = this.bundle.product.surfaces;
    const shot = this.ctx.state.lastScreenshotId ? this.session.getScreenshot(this.ctx.state.lastScreenshotId) : undefined;

    for (const e of drained.console) {
      const surfaceId = guessSurface(e.pageUrl, surfaces, fallbackSurface);
      const { finding, duplicateOf } = fileFindingInternal(
        this.ctx,
        {
          severity: e.kind === "crash" ? "P0" : "P2",
          title: e.kind === "crash" ? "Page crashed" : `Uncaught exception: ${firstLine(e.text)}`,
          summary: `Recorded by the browser on ${e.pageUrl} at ${e.at}:\n${e.text}`,
          surfaceId,
          oracle: "hard-error",
          signature: e.kind === "crash" ? "crash" : e.text,
          stepsFrom: Math.max(0, this.ctx.state.trace.length - 8),
        },
        [...(shot ? [screenshotEvidence(shot, "Last screenshot before error", this.ctx.artifactUrl)] : []), consoleEvidence([e])!],
      );
      if (!duplicateOf) filed.push(finding.id);
    }
    for (const f of drained.network) {
      const surfaceId = guessSurface(f.pageUrl, surfaces, fallbackSurface);
      const endpoint = stripQuery(f.url);
      const { finding, duplicateOf } = fileFindingInternal(
        this.ctx,
        {
          severity: f.status !== undefined ? "P1" : "P3",
          title: f.status !== undefined ? `HTTP ${f.status} from ${f.method} ${endpoint}` : `Request never completed: ${f.method} ${endpoint} (${f.failureText})`,
          summary: `Observed while on ${f.pageUrl} at ${f.at}. ${f.status !== undefined ? "The server returned an error status." : "The request was aborted or failed at the network layer."}`,
          surfaceId,
          oracle: "hard-error",
          signature: `${f.method} ${endpoint} ${f.status ?? f.failureText}`,
          stepsFrom: Math.max(0, this.ctx.state.trace.length - 8),
        },
        [...(shot ? [screenshotEvidence(shot, "Last screenshot before error", this.ctx.artifactUrl)] : []), networkEvidence([f])!],
      );
      if (!duplicateOf) filed.push(finding.id);
    }
    if (filed.length) this.log(`auto-filed ${filed.length} hard error finding(s)`);
    return filed;
  }

  private budgetNotice(): string {
    const remaining = this.remainingMs();
    const threshold = Math.max(60_000, this.bundle.budgetSeconds * 1_000 * 0.15);
    if (remaining > threshold) return "";
    if (!this.warnedBudget) {
      this.warnedBudget = true;
      return `\n\n[Budget: about ${Math.max(0, Math.round(remaining / 1_000))}s left. Wrap up: mark visited surfaces and call done.]`;
    }
    return `\n\n[Budget: ${Math.max(0, Math.round(remaining / 1_000))}s left. Call done now.]`;
  }

  /**
   * Keep the last N tool rounds verbatim and shrink older tool results to
   * one line each. Assistant tool_use blocks stay so the pairing is valid.
   */
  private compactHistory(keepRecent = this.opts.keepRecentRounds ?? 10): void {
    const rounds: number[] = [];
    this.messages.forEach((m, i) => {
      if (m.role === "user" && "toolResults" in m) rounds.push(i);
    });
    const toCompact = rounds.slice(0, Math.max(0, rounds.length - keepRecent));
    for (const i of toCompact) {
      const m = this.messages[i];
      if (!m || m.role !== "user" || !("toolResults" in m)) continue;
      m.toolResults = m.toolResults.map((r) => ({
        toolCallId: r.toolCallId,
        content: r.content.length > 200 ? `${firstLine(r.content.replace(/^Hard errors[\s\S]*?\n\n/, "")).slice(0, 160)} … [older result compacted]` : r.content,
        isError: r.isError,
      }));
    }
  }
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? s;
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
