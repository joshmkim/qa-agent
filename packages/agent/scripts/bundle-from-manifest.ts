/**
 * Build a standalone ContextBundle from a repo's `.qa/manifest.yaml` so one
 * agent can be run by hand against a real environment before the
 * control-plane's manifest loader exists.
 *
 *   pnpm --filter @qa-agent/agent bundle -- --manifest ~/repo/.qa/manifest.yaml \
 *     --base-url https://beta.example.com --out /tmp/bundle.json \
 *     [--disposition methodical] [--focus cart,checkout] [--budget 300] [--pr-title "..."] [--pr-body "..."]
 *
 * Change context is a stub unless --pr-title/--pr-body are given; the point
 * of this script is the product context.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { ContextBundle, Disposition, Invariant, Severity, Surface, SurfaceKind } from "@qa-agent/shared-types";

const require = createRequire(import.meta.url);
// js-yaml is hoisted in the workspace (a dependency of other packages); avoid adding a dep just for a dev script.
const yaml = require("js-yaml") as { load(s: string): unknown };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface ManifestSurface {
  id: string;
  kind: SurfaceKind;
  name: string;
  locator: string;
  description?: string;
}
interface ManifestInvariant {
  id: string;
  statement: string;
  severity: Severity;
  check?: string;
}
interface Manifest {
  version: number;
  product: { name: string; intent: string; stakeholders?: string[] };
  surfaces: ManifestSurface[];
  invariants: ManifestInvariant[];
  boundaries?: string[];
}

async function main() {
  const manifestPath = arg("manifest");
  const baseUrl = arg("base-url");
  if (!manifestPath || !baseUrl) {
    console.error("usage: bundle --manifest <path> --base-url <url> [--out file] [--disposition d] [--focus a,b] [--budget s]");
    process.exit(2);
  }
  const m = yaml.load(await readFile(manifestPath, "utf8")) as Manifest;

  const surfaces: Surface[] = m.surfaces.map((s) => ({
    id: s.id,
    kind: s.kind,
    name: s.name,
    locator: s.locator,
    ...(s.description ? { description: s.description } : {}),
  }));
  const invariants: Invariant[] = m.invariants.map((i) => ({
    id: i.id,
    statement: i.statement.trim(),
    severityOnViolation: i.severity,
    ...(i.check ? { check: i.check } : {}),
  }));

  const disposition = (arg("disposition") ?? "methodical") as Disposition;
  const focus = (arg("focus") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = focus.filter((id) => !surfaces.some((s) => s.id === id));
  if (unknown.length) {
    console.error(`unknown focus surface ids: ${unknown.join(", ")}\nknown: ${surfaces.map((s) => s.id).join(", ")}`);
    process.exit(2);
  }
  for (const s of surfaces) if (focus.includes(s.id)) s.touchedByChange = true;

  const prTitle = arg("pr-title");
  const bundle: ContextBundle = {
    runId: `run_local_${Date.now().toString(36)}`,
    agentId: "local-a001",
    persona: {
      id: "persona_local",
      name: { methodical: "Methodical Maya", "chaos-monkey": "Chaos Kai", "adversarial-fuzzer": "Fuzzer Fatima", "impatient-user": "Impatient Ivan" }[disposition] ?? "Tester",
      description: "Hand-launched agent exploring a real environment from the repo's code primitives.",
      disposition,
      focusAreas: focus,
    },
    change: {
      baseSha: "0000000",
      headSha: "0000000",
      commitCount: 0,
      filesChanged: 0,
      compareStatus: "identical",
      pullRequests: prTitle
        ? [
            {
              number: 0,
              title: prTitle,
              body: arg("pr-body") ?? "",
              author: "local",
              labels: [],
              linkedIssues: [],
              url: "",
              mergedAt: new Date().toISOString(),
              filesChanged: 0,
              additions: 0,
              deletions: 0,
            },
          ]
        : [],
    },
    product: {
      productName: m.product.name,
      intent:
        m.product.intent.trim() +
        (m.boundaries?.length ? `\n\nTeam rules (policy, always follow):\n${m.boundaries.map((b) => `- ${b.trim()}`).join("\n")}` : ""),
      stakeholders: m.product.stakeholders ?? [],
      surfaces,
      invariants,
      manifestVersion: `code primitives v${m.version} (${manifestPath})`,
    },
    environment: {
      stageName: arg("stage") ?? "beta",
      baseUrl,
      credentialsRef: arg("credentials") ?? "none (anonymous shopper; signed-in flows are out of reach)",
      // Manifest boundaries are policy sentences (folded into the intent above);
      // URL-level blocking is a separate list: --block host,/path,...
      blastRadiusBoundaries: (arg("block") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
    budgetSeconds: Number(arg("budget") ?? 300),
    saturatedSurfaceIds: [],
  };

  const out = arg("out");
  const json = JSON.stringify(bundle, null, 2);
  if (out) {
    await writeFile(out, json);
    console.error(`wrote ${out}: ${surfaces.length} surfaces, ${invariants.length} invariants, focus [${focus.join(", ")}], base ${baseUrl}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
