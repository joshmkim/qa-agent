import type { ChangeContext, ProductContext, Repository } from "@qa-agent/shared-types";

/**
 * Seam for the QA manifest work (owned separately). The orchestrator asks
 * for the ProductContext in force at a given SHA; how it is loaded (from
 * `.qa/manifest.yaml` in the repo via the Contents API, cached per
 * (repository, sha)) is the provider's business.
 */
export interface ManifestProvider {
  load(repository: Repository, sha: string): Promise<ProductContext>;
}

/**
 * Used until the real loader lands: an empty inventory with the repository
 * name as the product. Agents then discover surfaces themselves and coverage
 * is reported against whatever they marked visited.
 */
export class FallbackManifestProvider implements ManifestProvider {
  async load(repository: Repository): Promise<ProductContext> {
    return {
      productName: repository.name,
      intent: `Web application deployed from ${repository.fullName}. No QA manifest was found; infer the product's purpose from the pull requests and the pages you visit.`,
      stakeholders: [],
      surfaces: [],
      invariants: [],
      manifestVersion: "none",
    };
  }
}

/**
 * Mark surfaces whose locator or name shares a path token with a changed
 * file. Cheap heuristic; the manifest may also declare `touchedByChange`
 * mappings itself later.
 */
export function markTouchedSurfaces(product: ProductContext, change: ChangeContext): ProductContext {
  const files = (change.changedFiles ?? []).map((f) => f.path.toLowerCase());
  if (!files.length) return product;
  const surfaces = product.surfaces.map((s) => {
    if (s.touchedByChange !== undefined) return s;
    const tokens = [s.id, s.name, s.locator]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !GENERIC.has(t));
    const touched = tokens.length > 0 && files.some((f) => tokens.some((t) => f.includes(t)));
    return touched ? { ...s, touchedByChange: true } : s;
  });
  return { ...product, surfaces };
}

const GENERIC = new Set(["page", "form", "button", "step", "view", "data", "test", "index", "main", "home"]);
