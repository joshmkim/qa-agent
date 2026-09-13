import { createHash, randomUUID } from "node:crypto";
import type { Evidence, Finding, OracleSource, Severity } from "@qa-agent/shared-types";
import type { ConsoleError, NetworkFailure, Screenshot } from "./browser/session";

/**
 * Normalize an error signature so the same bug found by different agents on
 * different data collapses to one key: strip ids, numbers, hashes, and
 * whitespace noise; keep the shape of the message.
 */
export function normalizeSignature(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/[^\s"']+/g, (u) => {
      try {
        const url = new URL(u);
        return url.origin + url.pathname.replace(/\/[0-9a-f-]{8,}|\/\d+/g, "/:id");
      } catch {
        return "url";
      }
    })
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ":uuid")
    .replace(/\b[0-9a-f]{12,}\b/g, ":hash")
    .replace(/\b\d+(\.\d+)?\b/g, ":n")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function dedupeKey(surfaceId: string, oracle: OracleSource, signature: string): string {
  return createHash("sha256").update(`${surfaceId}\u0000${oracle}\u0000${normalizeSignature(signature)}`).digest("hex").slice(0, 24);
}

export function screenshotEvidence(shot: Screenshot, label = "Screenshot", toUrl: (p: string) => string = (p) => p): Evidence {
  return { id: `ev_${randomUUID().slice(0, 8)}`, kind: "screenshot", label, content: toUrl(shot.path), capturedAt: shot.capturedAt };
}

export function videoEvidence(url: string, label = "Session recording"): Evidence {
  return { id: `ev_${randomUUID().slice(0, 8)}`, kind: "video", label, content: url, capturedAt: new Date().toISOString() };
}

export function consoleEvidence(errors: ConsoleError[]): Evidence | undefined {
  if (!errors.length) return undefined;
  return {
    id: `ev_${randomUUID().slice(0, 8)}`,
    kind: "log",
    label: `Browser console (${errors.length})`,
    content: errors.map((e) => `[${e.at}] ${e.kind} @ ${e.pageUrl}\n${e.text}`).join("\n\n").slice(0, 8_000),
    capturedAt: errors[errors.length - 1]?.at ?? new Date().toISOString(),
  };
}

export function networkEvidence(failures: NetworkFailure[]): Evidence | undefined {
  if (!failures.length) return undefined;
  return {
    id: `ev_${randomUUID().slice(0, 8)}`,
    kind: "network",
    label: `Failed requests (${failures.length})`,
    content: failures
      .map((f) => `[${f.at}] ${f.method} ${f.url} -> ${f.status ?? f.failureText ?? "?"} (from ${f.pageUrl})`)
      .join("\n")
      .slice(0, 8_000),
    capturedAt: failures[failures.length - 1]?.at ?? new Date().toISOString(),
  };
}

export interface NewFindingInput {
  runId: string;
  agentId: string;
  personaName: string;
  severity: Severity;
  title: string;
  summary: string;
  surfaceId: string;
  oracle: OracleSource;
  invariantId?: string;
  /** Text used for the dedupe key; defaults to the title. */
  signature?: string;
  reproSteps: Finding["reproSteps"];
  evidence: Evidence[];
}

export function newFinding(input: NewFindingInput): Finding {
  const { signature, ...rest } = input;
  return {
    id: `fnd_${randomUUID().slice(0, 12)}`,
    ...rest,
    dedupeKey: dedupeKey(input.surfaceId, input.oracle, signature ?? input.title),
    status: "new",
    reportedAt: new Date().toISOString(),
  };
}
