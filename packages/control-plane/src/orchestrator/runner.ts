import type { AgentResult, ContextBundle } from "@qa-agent/shared-types";
import type { ArtifactStore } from "../artifacts";

/**
 * How the orchestrator executes one agent. In-process today; the same
 * interface fronts a container/queue spawn later (the runtime-profile seam
 * from project-context.md).
 */
export interface AgentRunner {
  run(bundle: ContextBundle): Promise<AgentResult>;
}

export interface InProcessRunnerOptions {
  headless?: boolean;
  /** Extra browser headers, e.g. a preprod bypass token. */
  extraHTTPHeaders?: Record<string, string>;
  maxSteps?: number;
  /** Record a .webm per agent; path lands on AgentResult.videoPath. */
  recordVideo?: boolean;
  /**
   * Where screenshots/videos go and how they're addressed. Without it,
   * evidence carries local paths the web can't render.
   */
  artifacts?: ArtifactStore;
  log?: (msg: string) => void;
}

/**
 * Runs `@qa-agent/agent` in this process. The import is dynamic so the
 * control-plane boots (webhooks, API, UI reads) even when Playwright's
 * browser isn't installed; only orchestration then fails, per run.
 */
export class InProcessAgentRunner implements AgentRunner {
  constructor(private readonly opts: InProcessRunnerOptions = {}) {}

  async run(bundle: ContextBundle): Promise<AgentResult> {
    const { runAgent } = await import("@qa-agent/agent");
    const { artifacts } = this.opts;
    return runAgent(bundle, {
      headless: this.opts.headless,
      extraHTTPHeaders: this.opts.extraHTTPHeaders,
      maxSteps: this.opts.maxSteps,
      recordVideo: this.opts.recordVideo,
      screenshotDir: artifacts?.dirFor(bundle.runId, bundle.agentId),
      artifactUrl: artifacts ? (p) => artifacts.urlFor(bundle.runId, bundle.agentId, p) : undefined,
      log: this.opts.log ? (m) => this.opts.log!(`[agent ${bundle.agentId}] ${m}`) : undefined,
    });
  }
}

/** Run `items` through `fn` with at most `limit` in flight; failures never reject the batch. */
export async function runWave<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onError: (item: T, err: unknown) => R,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      const item = items[i] as T;
      try {
        results[i] = await fn(item);
      } catch (err) {
        results[i] = onError(item, err);
      }
    }
  });
  await Promise.all(workers);
  return results;
}
