import type { Disposition, Persona, ProductContext } from "@qa-agent/shared-types";

/** Fleet mix. Methodical agents carry coverage; the others find the weird bugs. */
const MIX: Array<{ disposition: Disposition; weight: number }> = [
  { disposition: "methodical", weight: 0.4 },
  { disposition: "chaos-monkey", weight: 0.25 },
  { disposition: "adversarial-fuzzer", weight: 0.2 },
  { disposition: "impatient-user", weight: 0.15 },
];

const NAMES: Record<Disposition, string[]> = {
  methodical: ["Methodical Maya", "Careful Chen", "Thorough Theo", "Diligent Dana", "Steady Sam"],
  "chaos-monkey": ["Chaos Kai", "Random Riley", "Wildcard Wen", "Jitter Jo"],
  "adversarial-fuzzer": ["Fuzzer Fatima", "Probe Pavel", "Edge-case Eli", "Boundary Bo"],
  "impatient-user": ["Impatient Ivan", "Hurried Hana", "Rushing Ravi", "Skimmer Sky"],
};

const DESCRIPTIONS: Record<Disposition, string> = {
  methodical: "A meticulous tester who completes every flow end to end and verifies numbers against the invariants.",
  "chaos-monkey": "A tester who does things out of order, double-submits, refreshes mid-flow and hunts for state bugs.",
  "adversarial-fuzzer": "A security-minded tester who feeds boundary values and malformed input to forms and endpoints.",
  "impatient-user": "A real user in a hurry who skips instructions, clicks fast and notices anything that silently fails.",
};

/**
 * Split `count` agents across dispositions by weight, largest-remainder so
 * small fleets still get at least one of the heavier dispositions.
 */
export function allocateDispositions(count: number): Disposition[] {
  if (count <= 0) return [];
  const raw = MIX.map((m) => ({ ...m, exact: m.weight * count }));
  const floors = raw.map((r) => Math.floor(r.exact));
  let remaining = count - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (remaining <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    remaining -= 1;
  }
  const out: Disposition[] = [];
  // Interleave so a wave of N agents has a mix, not 40 methodical then 25 chaos.
  const buckets = raw.map((r, i) => ({ disposition: r.disposition, left: floors[i] ?? 0 }));
  while (out.length < count) {
    for (const b of buckets) {
      if (b.left > 0 && out.length < count) {
        out.push(b.disposition);
        b.left -= 1;
      }
    }
  }
  return out;
}

/**
 * Focus areas: surfaces touched by the change are spread across agents first
 * (every touched surface gets covered before any untouched one), then the
 * rest. Each agent gets a small, distinct slice so the fleet fans out.
 */
export function buildPersonas(count: number, product: ProductContext, focusPerAgent = 3): Persona[] {
  const dispositions = allocateDispositions(count);
  const touched = product.surfaces.filter((s) => s.touchedByChange).map((s) => s.id);
  const rest = product.surfaces.filter((s) => !s.touchedByChange).map((s) => s.id);
  const ordered = [...touched, ...rest];
  const nameCounters: Partial<Record<Disposition, number>> = {};

  return dispositions.map((disposition, i) => {
    const focusAreas: string[] = [];
    if (ordered.length) {
      // Rotate through the ordered list starting at a different offset per agent.
      for (let k = 0; k < Math.min(focusPerAgent, ordered.length); k++) {
        const id = ordered[(i * focusPerAgent + k) % ordered.length];
        if (id && !focusAreas.includes(id)) focusAreas.push(id);
      }
      // Guarantee every agent has at least one touched surface while any exist.
      if (touched.length && !focusAreas.some((id) => touched.includes(id))) {
        focusAreas.unshift(touched[i % touched.length] as string);
      }
    }
    const n = (nameCounters[disposition] = (nameCounters[disposition] ?? 0) + 1);
    const pool = NAMES[disposition];
    const base = pool[(n - 1) % pool.length] as string;
    const name = n > pool.length ? `${base} ${Math.ceil(n / pool.length)}` : base;
    return {
      id: `persona_${i + 1}`,
      name,
      description: DESCRIPTIONS[disposition],
      disposition,
      focusAreas,
    };
  });
}
