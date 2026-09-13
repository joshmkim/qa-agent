import type {
  AgentResult,
  ChangeContext,
  CoverageSummary,
  Finding,
  FleetSummary,
  GateVerdict,
  Persona,
  ProductContext,
  Severity,
} from "@qa-agent/shared-types";

export interface TriageInput {
  results: AgentResult[];
  personas: Persona[];
  product: ProductContext;
  change: ChangeContext;
  agentsRequested: number;
}

export interface TriageOutput {
  /** Every finding, canonical ones first, with `triage` populated and duplicates marked. */
  findings: Finding[];
  verdict: Exclude<GateVerdict, "pending">;
  confidenceStatement: string;
  confidenceScore: number;
  coverage: CoverageSummary;
  fleet: FleetSummary;
}

const SEVERITY_ORDER: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/**
 * Collapse findings that share a dedupeKey. The canonical copy is the one
 * with the shortest repro (ties: earliest). Independent reproduction by
 * another agent is recorded as `reproducedFromCleanSession`, since every
 * agent starts from a fresh browser context; a dedicated replay from a
 * clean session is a follow-up.
 */
export function dedupeFindings(all: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const f of all) groups.set(f.dedupeKey, [...(groups.get(f.dedupeKey) ?? []), f]);

  const out: Finding[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort(
      (a, b) => a.reproSteps.length - b.reproSteps.length || a.reportedAt.localeCompare(b.reportedAt),
    );
    const canonical = sorted[0] as Finding;
    const dups = sorted.slice(1);
    const otherAgents = new Set(dups.map((d) => d.agentId).filter((id) => id !== canonical.agentId));
    out.push({
      ...canonical,
      status: otherAgents.size > 0 ? "reproduced" : "new",
      triage: {
        ...canonical.triage,
        reproducedFromCleanSession: otherAgents.size > 0,
        duplicateCount: dups.length,
        note: otherAgents.size > 0 ? `Hit independently by ${otherAgents.size + 1} agents.` : undefined,
      },
    });
    for (const d of dups) {
      out.push({
        ...d,
        status: "duplicate",
        triage: { ...d.triage, reproducedFromCleanSession: false, duplicateOf: canonical.id, duplicateCount: 0 },
      });
    }
  }
  return out.sort((a, b) => {
    if ((a.status === "duplicate") !== (b.status === "duplicate")) return a.status === "duplicate" ? 1 : -1;
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.reportedAt.localeCompare(b.reportedAt);
  });
}

/**
 * Best-effort attribution: a PR whose title/body mentions the finding's
 * surface or title tokens. With a single PR in the window it is the only
 * candidate.
 */
export function suspectPr(finding: Finding, product: ProductContext, change: ChangeContext): number | undefined {
  const prs = change.pullRequests;
  if (prs.length === 0) return undefined;
  if (prs.length === 1) return prs[0]?.number;
  const surface = product.surfaces.find((s) => s.id === finding.surfaceId);
  const tokens = new Set(
    [finding.surfaceId, surface?.name ?? "", surface?.locator ?? "", finding.title]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOP.has(t)),
  );
  let best: { number: number; score: number } | undefined;
  for (const pr of prs) {
    const text = `${pr.title} ${pr.body} ${pr.labels.join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of tokens) if (text.includes(t)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { number: pr.number, score };
  }
  return best?.number;
}

const STOP = new Set(["page", "form", "button", "error", "from", "http", "with", "when", "returns", "invariant", "violated", "uncaught", "exception"]);

export function computeCoverage(product: ProductContext, visited: Set<string>, checkedInvariants: Set<string>): CoverageSummary {
  const known = new Set(product.surfaces.map((s) => s.id));
  const changed = product.surfaces.filter((s) => s.touchedByChange);
  return {
    surfacesTotal: product.surfaces.length,
    surfacesVisited: [...visited].filter((id) => known.has(id)).length,
    changedSurfacesTotal: changed.length,
    changedSurfacesVisited: changed.filter((s) => visited.has(s.id)).length,
    invariantsTotal: product.invariants.length,
    invariantsChecked: product.invariants.filter((i) => checkedInvariants.has(i.id)).length,
  };
}

export function summarizeFleet(results: AgentResult[], personas: Persona[], agentsRequested: number): FleetSummary {
  const dispositions: Record<string, number> = {};
  for (const p of personas) dispositions[p.disposition] = (dispositions[p.disposition] ?? 0) + 1;
  return {
    agentsRequested,
    agentsCompleted: results.filter((r) => r.status === "completed").length,
    agentsFailed: results.filter((r) => r.status === "failed").length,
    dispositions,
    totalActions: results.reduce((n, r) => n + r.trace.length, 0),
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

export function scoreConfidence(canonical: Finding[], coverage: CoverageSummary, fleet: FleetSummary): number {
  let score = 1;
  for (const f of canonical) {
    if (f.severity === "P0") score -= 0.6;
    else if (f.severity === "P1") score -= 0.15;
    else if (f.severity === "P2") score -= 0.03;
  }
  score = Math.max(score, 0.05);
  const coverageFactor =
    coverage.changedSurfacesTotal > 0
      ? coverage.changedSurfacesVisited / coverage.changedSurfacesTotal
      : coverage.surfacesTotal > 0
        ? coverage.surfacesVisited / coverage.surfacesTotal
        : 0.6; // no manifest: coverage is unknown, cap confidence
  const completion = fleet.agentsRequested > 0 ? fleet.agentsCompleted / fleet.agentsRequested : 0;
  score *= 0.5 + 0.5 * coverageFactor;
  score *= 0.6 + 0.4 * completion;
  return Math.round(Math.min(0.98, Math.max(0.05, score)) * 100) / 100;
}

export function writeConfidenceStatement(
  verdict: TriageOutput["verdict"],
  canonical: Finding[],
  coverage: CoverageSummary,
  fleet: FleetSummary,
  product: ProductContext,
  visited: Set<string>,
): string {
  const p0 = canonical.filter((f) => f.severity === "P0");
  const p1 = canonical.filter((f) => f.severity === "P1");
  const lower = canonical.length - p0.length - p1.length;
  const parts: string[] = [];

  parts.push(verdict === "block" ? "Low confidence to promote." : p1.length ? "Moderate confidence to promote." : "High confidence to promote.");

  if (p0.length) {
    const where = [...new Set(p0.map((f) => surfaceLabel(f.surfaceId, product)))].slice(0, 3).join(", ");
    const repro = p0.filter((f) => f.triage?.reproducedFromCleanSession).length;
    const prs = [...new Set(p0.map((f) => f.triage?.suspectedPrNumber).filter((n): n is number => n !== undefined))];
    parts.push(
      `${p0.length} P0 ${p0.length === 1 ? "regression" : "regressions"} found on ${where}${repro ? `, ${repro} reproduced independently by other agents` : ""}${prs.length ? `; suspected ${prs.map((n) => `#${n}`).join(", ")}` : ""}.`,
    );
  }
  if (p1.length) parts.push(`${p1.length} P1 ${p1.length === 1 ? "issue" : "issues"} (core flow degraded).`);
  if (lower) parts.push(`${lower} lower-severity finding${lower === 1 ? "" : "s"}.`);
  if (!canonical.length) parts.push("No findings.");

  const agents = `${fleet.agentsCompleted} of ${fleet.agentsRequested} agents completed (${fleet.totalActions} actions)`;
  if (coverage.changedSurfacesTotal > 0) {
    parts.push(`${coverage.changedSurfacesVisited} of ${coverage.changedSurfacesTotal} changed surfaces (${pct(coverage.changedSurfacesVisited, coverage.changedSurfacesTotal)}) and ${coverage.surfacesVisited} of ${coverage.surfacesTotal} surfaces overall covered by ${agents}.`);
  } else if (coverage.surfacesTotal > 0) {
    parts.push(`${coverage.surfacesVisited} of ${coverage.surfacesTotal} surfaces (${pct(coverage.surfacesVisited, coverage.surfacesTotal)}) covered by ${agents}; no surface was mapped to the change.`);
  } else {
    parts.push(`No QA manifest, so coverage is unmeasured: ${agents}, ${visited.size} self-reported surfaces visited.`);
  }
  if (coverage.invariantsTotal > 0) parts.push(`${coverage.invariantsChecked} of ${coverage.invariantsTotal} invariants checked.`);

  const gaps = product.surfaces.filter((s) => s.touchedByChange && !visited.has(s.id)).map((s) => s.name);
  if (gaps.length) parts.push(`Gap: ${gaps.slice(0, 3).join(", ")}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ""} not reached.`);
  if (fleet.agentsFailed) parts.push(`${fleet.agentsFailed} agent${fleet.agentsFailed === 1 ? "" : "s"} failed to run.`);

  return parts.join(" ");
}

function surfaceLabel(id: string, product: ProductContext): string {
  return product.surfaces.find((s) => s.id === id)?.name ?? id;
}

/**
 * The triage judge: dedupe, attribute, decide, and explain. Deterministic
 * today; an LLM pass over the canonical findings (re-scoring severity
 * against the product description, writing a richer statement) slots in
 * after `dedupeFindings` without changing the contract.
 */
export function triage(input: TriageInput): TriageOutput {
  const { results, personas, product, change, agentsRequested } = input;
  const deduped = dedupeFindings(results.flatMap((r) => r.findings)).map((f) =>
    f.status === "duplicate" ? f : { ...f, triage: { ...f.triage!, suspectedPrNumber: suspectPr(f, product, change) } },
  );
  const canonical = deduped.filter((f) => f.status !== "duplicate" && f.status !== "dismissed");

  const visited = new Set<string>();
  const checked = new Set<string>();
  for (const r of results) {
    for (const id of r.visitedSurfaceIds) visited.add(id);
    for (const id of r.checkedInvariantIds) checked.add(id);
  }
  const coverage = computeCoverage(product, visited, checked);
  const fleet = summarizeFleet(results, personas, agentsRequested);
  const verdict: TriageOutput["verdict"] = canonical.some((f) => f.severity === "P0") ? "block" : "pass";

  return {
    findings: deduped,
    verdict,
    confidenceScore: scoreConfidence(canonical, coverage, fleet),
    confidenceStatement: writeConfidenceStatement(verdict, canonical, coverage, fleet, product, visited),
    coverage,
    fleet,
  };
}
