import { bool, ok, truncate, type ToolDefinition } from "./types";

/**
 * Observation tools read what the BrowserSession recorded passively. The
 * exploration loop also drains hard errors after every step, so these are
 * for the agent to investigate on demand (4xx, console noise, "did that
 * click hit the API at all?").
 */

export const getConsoleErrors: ToolDefinition = {
  name: "get_console_errors",
  description: "List browser console errors and uncaught exceptions recorded this session (most recent last).",
  inputSchema: {
    type: "object",
    properties: { last: { type: "integer", description: "Only the N most recent. Default 20." } },
    additionalProperties: false,
  },
  describe: () => "Get console errors",
  async execute(args, ctx) {
    const n = typeof args.last === "number" ? args.last : 20;
    const all = ctx.session.allConsoleErrors();
    if (!all.length) return ok("No console errors recorded.");
    const recent = all.slice(-n);
    return ok(
      `${all.length} console error(s) total, showing ${recent.length}:\n` +
        recent.map((e) => `- [${e.kind}] ${truncate(e.text, 400)}  (at ${e.pageUrl})`).join("\n"),
    );
  },
};

export const getNetworkFailures: ToolDefinition = {
  name: "get_network_failures",
  description: "List HTTP responses >= 400 and requests that never completed, recorded this session. Set serverOnly=true for 5xx only.",
  inputSchema: {
    type: "object",
    properties: {
      last: { type: "integer", description: "Only the N most recent. Default 20." },
      serverOnly: { type: "boolean", description: "Only 5xx and aborted requests." },
    },
    additionalProperties: false,
  },
  describe: () => "Get network failures",
  async execute(args, ctx) {
    const n = typeof args.last === "number" ? args.last : 20;
    const serverOnly = bool(args, "serverOnly", false);
    let all = ctx.session.allNetworkFailures();
    if (serverOnly) all = all.filter((f) => f.status === undefined || f.status >= 500);
    if (!all.length) return ok(serverOnly ? "No 5xx or aborted requests recorded." : "No failed requests recorded.");
    const recent = all.slice(-n);
    return ok(
      `${all.length} failed request(s) total, showing ${recent.length}:\n` +
        recent.map((f) => `- ${f.method} ${f.url} -> ${f.status ?? f.failureText}  (from ${f.pageUrl})`).join("\n"),
    );
  },
};

export const OBSERVATION_TOOLS: ToolDefinition[] = [getConsoleErrors, getNetworkFailures];
