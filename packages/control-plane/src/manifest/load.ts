import picomatch from "picomatch";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { z } from "zod";
import type { ChangeContext, ManifestSnapshot, ProductContext } from "@qa-agent/shared-types";
import type { InstallationOctokit } from "../github/app";
import type { RepoRef } from "../github/diff";

export const DEFAULT_MANIFEST_PATH = ".qa/manifest.yaml";

const severity = z.enum(["P0", "P1", "P2", "P3"]);
const id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "use lowercase letters, digits, - and _");

/** v1 of the team-authored code primitives file (.qa/manifest.yaml). See docs/code-primitives.md. */
const manifestSchema = z
  .object({
    version: z.literal(1),
    product: z.object({
      name: z.string().min(1),
      intent: z.string().min(1),
      stakeholders: z.array(z.string()).default([]),
    }),
    surfaces: z
      .array(
        z.object({
          id,
          kind: z.enum(["page", "form", "button", "endpoint", "flow"]),
          name: z.string().min(1),
          locator: z.string().min(1),
          description: z.string().optional(),
          sources: z.array(z.string().min(1)).optional(),
        }),
      )
      .default([]),
    invariants: z
      .array(
        z.object({
          id,
          statement: z.string().min(1),
          severity,
          surfaces: z.array(z.string()).optional(),
          check: z.string().optional(),
        }),
      )
      .default([]),
    boundaries: z.array(z.string().min(1)).default([]),
  })
  .superRefine((m, ctx) => {
    const surfaceIds = new Set<string>();
    m.surfaces.forEach((s, i) => {
      if (surfaceIds.has(s.id)) {
        ctx.addIssue({ code: "custom", path: ["surfaces", i, "id"], message: `duplicate surface id "${s.id}"` });
      }
      surfaceIds.add(s.id);
    });
    const invariantIds = new Set<string>();
    m.invariants.forEach((inv, i) => {
      if (invariantIds.has(inv.id)) {
        ctx.addIssue({ code: "custom", path: ["invariants", i, "id"], message: `duplicate invariant id "${inv.id}"` });
      }
      invariantIds.add(inv.id);
      inv.surfaces?.forEach((ref, j) => {
        if (!surfaceIds.has(ref)) {
          ctx.addIssue({ code: "custom", path: ["invariants", i, "surfaces", j], message: `unknown surface "${ref}"` });
        }
      });
    });
  });

export type ParseResult = { ok: true; product: ProductContext } | { ok: false; errors: string[] };

/** `["invariants", 2, "surfaces", 0]` -> `invariants[2].surfaces[0]` */
function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((p, i) => (typeof p === "number" ? `[${p}]` : `${i === 0 ? "" : "."}${String(p)}`))
    .join("");
}

/**
 * Parse and validate manifest YAML. `version` is the manifest's content
 * version (the blob SHA when loaded from GitHub).
 */
export function parseManifest(text: string, version = "local"): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    const where = err instanceof YAMLParseError && err.linePos ? ` (line ${err.linePos[0].line})` : "";
    return { ok: false, errors: [`YAML syntax error${where}: ${(err as Error).message.split("\n")[0]}`] };
  }

  const result = manifestSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => {
        const path = formatPath(issue.path);
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }

  const m = result.data;
  return {
    ok: true,
    product: {
      productName: m.product.name,
      intent: m.product.intent,
      stakeholders: m.product.stakeholders,
      surfaces: m.surfaces.map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        locator: s.locator,
        description: s.description,
        sources: s.sources,
      })),
      invariants: m.invariants.map((inv) => ({
        id: inv.id,
        statement: inv.statement,
        check: inv.check,
        severityOnViolation: inv.severity,
        surfaceIds: inv.surfaces,
      })),
      manifestVersion: version,
      boundaries: m.boundaries,
    },
  };
}

/** Read and validate the manifest from a repo at `commitSha`. Never throws. */
export async function loadManifest(
  octokit: InstallationOctokit,
  ref: RepoRef,
  commitSha: string,
  path = DEFAULT_MANIFEST_PATH,
): Promise<ManifestSnapshot> {
  const base = { path, commitSha, loadedAt: new Date().toISOString() };
  let content: string;
  let blobSha: string;
  try {
    const { data } = await octokit.rest.repos.getContent({ ...ref, path, ref: commitSha });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return { ...base, status: "invalid", errors: [`${path} is not a file`] };
    }
    content = Buffer.from(data.content, "base64").toString("utf8");
    blobSha = data.sha;
  } catch (err) {
    if ((err as { status?: number }).status === 404) return { ...base, status: "missing" };
    return { ...base, status: "error", errors: [(err as Error).message] };
  }

  const parsed = parseManifest(content, blobSha.slice(0, 7));
  return parsed.ok
    ? { ...base, status: "loaded", product: parsed.product }
    : { ...base, status: "invalid", errors: parsed.errors };
}

/**
 * Surfaces whose `sources` match a changed file. When GitHub truncated the
 * file list we can't tell, so every surface with sources counts as touched.
 */
export function markTouched(
  product: ProductContext,
  change: Pick<ChangeContext, "changedFiles" | "filesTruncated">,
): ProductContext {
  const paths = (change.changedFiles ?? []).map((f) => f.path);
  return {
    ...product,
    surfaces: product.surfaces.map((s) => {
      if (!s.sources?.length) return { ...s, touchedByChange: false };
      if (change.filesTruncated) return { ...s, touchedByChange: true };
      const matches = picomatch(s.sources, { dot: true });
      return { ...s, touchedByChange: paths.some((p) => matches(p)) };
    }),
  };
}
