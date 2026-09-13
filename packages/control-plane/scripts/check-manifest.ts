/**
 * Validate a QA manifest locally before committing it.
 *
 *   pnpm --filter @qa-agent/control-plane manifest:check <path> [--changed a.ts,b.ts]
 *
 * --changed previews which surfaces a change to those repo paths would mark
 * as touched.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markTouched, parseManifest } from "../src/manifest/load";

const args = process.argv.slice(2);
const changedIndex = args.indexOf("--changed");
const changed = changedIndex >= 0 ? (args[changedIndex + 1] ?? "").split(",").filter(Boolean) : undefined;
const file = args.find((a, i) => !a.startsWith("--") && (changedIndex < 0 || i !== changedIndex + 1));

if (!file) {
  console.error("Usage: manifest:check <path to manifest.yaml> [--changed a.ts,b.ts]");
  process.exit(2);
}

// pnpm --filter runs scripts from the package directory; resolve against where the user ran it.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
const result = parseManifest(readFileSync(path, "utf8"));

if (!result.ok) {
  console.error(`✗ ${file} is invalid:`);
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const { product } = result;
console.log(`✓ ${file}: ${product.productName}`);
console.log(`  ${product.surfaces.length} surfaces, ${product.invariants.length} invariants, ${product.boundaries?.length ?? 0} boundaries`);

const bySeverity = product.invariants.reduce<Record<string, number>>((acc, inv) => {
  acc[inv.severityOnViolation] = (acc[inv.severityOnViolation] ?? 0) + 1;
  return acc;
}, {});
console.log(`  invariants by severity: ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);

const unmapped = product.surfaces.filter((s) => !s.sources?.length);
if (unmapped.length) {
  console.log(`  ⚠ ${unmapped.length} surface(s) without sources (never marked touched): ${unmapped.map((s) => s.id).join(", ")}`);
}

if (changed) {
  const touched = markTouched(product, {
    changedFiles: changed.map((p) => ({ path: p, status: "modified", additions: 0, deletions: 0 })),
  }).surfaces.filter((s) => s.touchedByChange);
  console.log(`\n  changing ${changed.join(", ")} touches ${touched.length} surface(s):`);
  for (const s of touched) console.log(`    - ${s.id} (${s.kind} ${s.locator})`);
}
