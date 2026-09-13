import type { AgentResult } from "@qa-agent/shared-types";

/**
 * Shared discovery board for one run. Agents publish what they visited and
 * found; the orchestrator reads it between waves to steer later agents away
 * from saturated surfaces. In-memory for now; becomes a table/Redis hash
 * when agents run out of process.
 */
export class DiscoveryBoard {
  private visits = new Map<string, number>();
  /** Visits to a surface since the last new distinct finding on it. */
  private quietVisits = new Map<string, number>();
  private findingsBySurface = new Map<string, Set<string>>();
  private results: AgentResult[] = [];

  constructor(private readonly saturationThreshold: number) {}

  publish(result: AgentResult): void {
    this.results.push(result);
    const newFindingOn = new Set<string>();
    for (const f of result.findings) {
      const set = this.findingsBySurface.get(f.surfaceId) ?? new Set<string>();
      if (!set.has(f.dedupeKey)) {
        set.add(f.dedupeKey);
        newFindingOn.add(f.surfaceId);
      }
      this.findingsBySurface.set(f.surfaceId, set);
    }
    for (const id of new Set([...result.visitedSurfaceIds, ...newFindingOn])) {
      this.visits.set(id, (this.visits.get(id) ?? 0) + 1);
      this.quietVisits.set(id, newFindingOn.has(id) ? 0 : (this.quietVisits.get(id) ?? 0) + 1);
    }
  }

  /**
   * A surface is saturated once `threshold` agents in a row covered it
   * without turning up anything new. A surface that keeps producing
   * findings stays open: that is where the bugs are.
   */
  saturatedSurfaceIds(): string[] {
    const out: string[] = [];
    for (const [id, quiet] of this.quietVisits) {
      if (quiet >= this.saturationThreshold) out.push(id);
    }
    return out;
  }

  visitedSurfaceIds(): Set<string> {
    return new Set(this.visits.keys());
  }

  checkedInvariantIds(): Set<string> {
    const set = new Set<string>();
    for (const r of this.results) for (const id of r.checkedInvariantIds) set.add(id);
    return set;
  }

  allResults(): AgentResult[] {
    return [...this.results];
  }
}
