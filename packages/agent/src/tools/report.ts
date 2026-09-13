import type { Evidence, Finding, OracleSource, Severity } from "@qa-agent/shared-types";
import { consoleEvidence, dedupeKey, networkEvidence, newFinding, screenshotEvidence } from "../findings";
import { bool, fail, num, ok, requireStr, str, strList, type ToolContext, type ToolDefinition } from "./types";

const SEVERITIES: Severity[] = ["P0", "P1", "P2", "P3"];
const ORACLES: OracleSource[] = ["hard-error", "invariant", "llm-judgment"];

function knownSurface(ctx: ToolContext, surfaceId: string): boolean {
  const surfaces = ctx.bundle.product.surfaces;
  return surfaces.length === 0 || surfaces.some((s) => s.id === surfaceId);
}

function surfaceList(ctx: ToolContext): string {
  return ctx.bundle.product.surfaces.map((s) => `${s.id} (${s.kind}: ${s.name})`).join(", ") || "(manifest has no surfaces; use a short slug like \"checkout-page\")";
}

/** Gather evidence for a finding: fresh screenshot + recorded errors. */
async function collectEvidence(ctx: ToolContext, capture: boolean): Promise<Evidence[]> {
  const evidence: Evidence[] = [];
  if (capture) {
    const shot = await ctx.session.screenshot("finding").catch(() => undefined);
    if (shot) {
      ctx.state.lastScreenshotId = shot.id;
      evidence.push(screenshotEvidence(shot, "State when filed", ctx.artifactUrl));
    }
  } else if (ctx.state.lastScreenshotId) {
    const shot = ctx.session.getScreenshot(ctx.state.lastScreenshotId);
    if (shot) evidence.push(screenshotEvidence(shot, "Last screenshot", ctx.artifactUrl));
  }
  const hard = ctx.session.allConsoleErrors().filter((e) => e.kind !== "console").slice(-10);
  const consoleEv = consoleEvidence(hard);
  if (consoleEv) evidence.push(consoleEv);
  const net = networkEvidence(ctx.session.allNetworkFailures().slice(-10));
  if (net) evidence.push(net);
  return evidence;
}

export function fileFindingInternal(
  ctx: ToolContext,
  input: {
    severity: Severity;
    title: string;
    summary: string;
    surfaceId: string;
    oracle: OracleSource;
    invariantId?: string;
    signature?: string;
    stepsFrom?: number;
  },
  evidence: Evidence[],
): { finding: Finding; duplicateOf?: Finding } {
  const key = dedupeKey(input.surfaceId, input.oracle, input.signature ?? input.title);
  const existing = ctx.state.findings.find((f) => f.dedupeKey === key);
  const from = Math.max(0, Math.min(input.stepsFrom ?? 0, ctx.state.trace.length));
  const finding = newFinding({
    runId: ctx.bundle.runId,
    agentId: ctx.bundle.agentId,
    personaName: ctx.bundle.persona.name,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    surfaceId: input.surfaceId,
    oracle: input.oracle,
    invariantId: input.invariantId,
    signature: input.signature,
    reproSteps: ctx.state.trace.slice(from).map((s) => ({ ...s })),
    evidence,
  });
  if (existing) return { finding, duplicateOf: existing };
  ctx.state.findings.push(finding);
  return { finding };
}

export const fileFinding: ToolDefinition = {
  name: "file_finding",
  description:
    "Report a bug. Call this the moment you observe one; do not batch. The repro steps are your action trace from stepsFrom onward, so keep the path to the bug short. " +
    "oracle: hard-error (5xx, crash, uncaught exception, broken page), invariant (a listed invariant is violated; set invariantId), llm-judgment (behaviour contradicts the product intent or PR descriptions). " +
    "Severity: P0 blocks release (data loss, payment/checkout broken, crash on a core flow); P1 core flow degraded with no workaround; P2 secondary flow broken or workaround exists; P3 cosmetic.",
  inputSchema: {
    type: "object",
    properties: {
      severity: { type: "string", enum: SEVERITIES },
      title: { type: "string", description: "One line, specific: what broke where. Same bug on different data should get the same title." },
      summary: { type: "string", description: "What you did, what you expected, what happened. Include the exact text/values seen." },
      surfaceId: { type: "string", description: "Manifest surface id where the bug shows." },
      oracle: { type: "string", enum: ORACLES },
      invariantId: { type: "string", description: "Required when oracle=invariant." },
      signature: { type: "string", description: "Optional error message or symptom used for dedupe; defaults to the title." },
      stepsFrom: { type: "integer", description: "Trace index where the repro starts (see step numbers in results). Default 0 = whole session." },
      captureScreenshot: { type: "boolean", description: "Default true." },
    },
    required: ["severity", "title", "summary", "surfaceId", "oracle"],
    additionalProperties: false,
  },
  describe: (a) => `File ${str(a, "severity") ?? "?"} finding: ${str(a, "title") ?? "?"}`,
  async execute(args, ctx) {
    const severity = requireStr(args, "severity") as Severity;
    if (!SEVERITIES.includes(severity)) return fail(`severity must be one of ${SEVERITIES.join(", ")}`);
    const oracle = requireStr(args, "oracle") as OracleSource;
    if (!ORACLES.includes(oracle)) return fail(`oracle must be one of ${ORACLES.join(", ")}`);
    const surfaceId = requireStr(args, "surfaceId");
    if (!knownSurface(ctx, surfaceId)) {
      return fail(`Unknown surfaceId "${surfaceId}". Use one of: ${surfaceList(ctx)}`);
    }
    const invariantId = str(args, "invariantId");
    if (oracle === "invariant") {
      if (!invariantId) return fail("oracle=invariant requires invariantId.");
      if (!ctx.bundle.product.invariants.some((i) => i.id === invariantId)) {
        return fail(`Unknown invariantId "${invariantId}". Known: ${ctx.bundle.product.invariants.map((i) => i.id).join(", ") || "(none)"}`);
      }
    }

    const evidence = await collectEvidence(ctx, bool(args, "captureScreenshot", true));
    const { finding, duplicateOf } = fileFindingInternal(
      ctx,
      {
        severity,
        title: requireStr(args, "title"),
        summary: requireStr(args, "summary"),
        surfaceId,
        oracle,
        invariantId,
        signature: str(args, "signature"),
        stepsFrom: num(args, "stepsFrom", 0),
      },
      evidence,
    );
    if (duplicateOf) {
      return ok(`Already filed as ${duplicateOf.id} ("${duplicateOf.title}"). Not duplicated. Move on to a different surface or scenario.`);
    }
    ctx.log(`finding ${finding.severity} ${finding.title}`);
    return ok(`Filed ${finding.id} [${finding.severity}] "${finding.title}" on ${surfaceId} with ${finding.reproSteps.length} repro steps and ${evidence.length} evidence items. Continue exploring; you don't need to re-verify it.`);
  },
};

export const checkInvariant: ToolDefinition = {
  name: "check_invariant",
  description:
    "Record that you evaluated a manifest invariant. If holds=false a finding is filed automatically at the invariant's severity, with your observation as the summary. Call this for every invariant you are able to test, pass or fail; it feeds coverage.",
  inputSchema: {
    type: "object",
    properties: {
      invariantId: { type: "string" },
      holds: { type: "boolean" },
      observation: { type: "string", description: "The concrete values you compared, e.g. \"cart total $58.00 vs line items $48.00 + tax $4.80\"." },
      surfaceId: { type: "string", description: "Where you checked it. Required when holds=false." },
    },
    required: ["invariantId", "holds", "observation"],
    additionalProperties: false,
  },
  describe: (a) => `Check invariant ${str(a, "invariantId") ?? "?"}: ${a.holds === false ? "VIOLATED" : "holds"}`,
  async execute(args, ctx) {
    const invariantId = requireStr(args, "invariantId");
    const inv = ctx.bundle.product.invariants.find((i) => i.id === invariantId);
    if (!inv) return fail(`Unknown invariantId "${invariantId}". Known: ${ctx.bundle.product.invariants.map((i) => i.id).join(", ") || "(none)"}`);
    const holds = bool(args, "holds", true);
    const observation = requireStr(args, "observation");
    ctx.state.checkedInvariantIds.add(invariantId);
    if (holds) return ok(`Recorded: ${invariantId} holds (${observation}).`);

    const surfaceId = str(args, "surfaceId");
    if (!surfaceId) return fail("surfaceId is required when an invariant is violated.");
    if (!knownSurface(ctx, surfaceId)) return fail(`Unknown surfaceId "${surfaceId}". Use one of: ${surfaceList(ctx)}`);
    const evidence = await collectEvidence(ctx, true);
    const { finding, duplicateOf } = fileFindingInternal(
      ctx,
      {
        severity: inv.severityOnViolation,
        title: `Invariant violated: ${inv.statement}`,
        summary: observation,
        surfaceId,
        oracle: "invariant",
        invariantId,
        signature: inv.id,
      },
      evidence,
    );
    if (duplicateOf) return ok(`Violation of ${invariantId} already filed as ${duplicateOf.id}.`);
    ctx.log(`invariant violated ${invariantId}`);
    return ok(`Recorded violation of ${invariantId} and filed ${finding.id} [${finding.severity}]. Continue exploring.`);
  },
};

export const markSurfaceVisited: ToolDefinition = {
  name: "mark_surface_visited",
  description: "Tell the orchestrator which manifest surfaces you have now exercised. Call after you finish with a page/form/flow, even if nothing was wrong. Drives the coverage report and steers other agents.",
  inputSchema: {
    type: "object",
    properties: {
      surfaceIds: { type: "array", items: { type: "string" } },
      note: { type: "string", description: "Optional one-line observation." },
    },
    required: ["surfaceIds"],
    additionalProperties: false,
  },
  describe: (a) => `Mark visited: ${strList(a, "surfaceIds").join(", ")}`,
  async execute(args, ctx) {
    const ids = strList(args, "surfaceIds");
    if (!ids.length) return fail("surfaceIds must be a non-empty array.");
    const unknown = ids.filter((id) => !knownSurface(ctx, id));
    for (const id of ids) if (knownSurface(ctx, id)) ctx.state.visitedSurfaceIds.add(id);
    const remaining = ctx.bundle.product.surfaces.filter((s) => !ctx.state.visitedSurfaceIds.has(s.id) && !ctx.bundle.saturatedSurfaceIds.includes(s.id));
    const focusLeft = remaining.filter((s) => ctx.bundle.persona.focusAreas.includes(s.id));
    return ok(
      `Recorded ${ids.length - unknown.length} surface(s).${unknown.length ? ` Ignored unknown ids: ${unknown.join(", ")}.` : ""}` +
        (focusLeft.length ? ` Still unvisited in your focus: ${focusLeft.map((s) => s.id).join(", ")}.` : remaining.length ? ` Unvisited elsewhere: ${remaining.slice(0, 8).map((s) => s.id).join(", ")}.` : " Every surface has been visited."),
    );
  },
};

export const done: ToolDefinition = {
  name: "done",
  description: "End your session. Call when your focus areas are covered, you have nothing productive left, or you are told the budget is nearly gone. Summarize what you covered and what you could not test.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      untested: { type: "array", items: { type: "string" }, description: "Surfaces or scenarios you could not reach, with the reason." },
    },
    required: ["summary"],
    additionalProperties: false,
  },
  describe: (a) => `Done: ${(str(a, "summary") ?? "").slice(0, 60)}`,
  async execute(args) {
    return ok(`Session ended. ${str(args, "summary") ?? ""}`, { done: true });
  },
};

export const REPORTING_TOOLS: ToolDefinition[] = [fileFinding, checkInvariant, markSurfaceVisited, done];
