import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";

/**
 * Screenshots and session videos the agents write. Local disk for now; the
 * layout `<runId>/<agentId>/<file>` is what an object-store prefix will look
 * like when this moves to S3/GCS, so Evidence.content URLs won't change shape.
 */
export const DEFAULT_ARTIFACT_DIR = path.join(tmpdir(), "qa-agent", "artifacts");

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
};

/** Ids and file names are single path segments; anything else is rejected. */
const SEGMENT = /^[A-Za-z0-9._@-]+$/;

export interface ArtifactStore {
  /** Directory an agent should write into. */
  dirFor(runId: string, agentId: string): string;
  /** Public URL for a file written under dirFor(). */
  urlFor(runId: string, agentId: string, localPath: string): string;
}

export function createArtifactStore(rootDir: string, publicUrl: string): ArtifactStore {
  const root = path.resolve(rootDir);
  return {
    dirFor: (runId, agentId) => path.join(root, safe(runId), safe(agentId)),
    urlFor: (runId, agentId, localPath) =>
      `${publicUrl}/api/artifacts/${encodeURIComponent(runId)}/${encodeURIComponent(agentId)}/${encodeURIComponent(path.basename(localPath))}`,
  };
}

function safe(segment: string): string {
  if (!SEGMENT.test(segment)) throw new Error(`Invalid artifact path segment: ${segment}`);
  return segment;
}

/**
 * GET /api/artifacts/:runId/:agentId/:file
 * Unauthenticated like the rest of /api today; screenshots of a preprod
 * environment are low-sensitivity, but this must sit behind the same auth
 * as the run pages before public exposure.
 */
export function artifactRoutes(rootDir: string): Hono {
  const root = path.resolve(rootDir);
  const app = new Hono();

  app.get("/:runId/:agentId/:file", async (c) => {
    const { runId, agentId, file } = c.req.param();
    if (![runId, agentId, file].every((s) => SEGMENT.test(s))) return c.json({ error: "Invalid artifact path" }, 400);
    const full = path.join(root, runId, agentId, file);
    // Belt and braces: the regex already excludes separators and "..".
    if (!full.startsWith(root + path.sep)) return c.json({ error: "Invalid artifact path" }, 400);

    let size: number;
    try {
      const s = await stat(full);
      if (!s.isFile()) return c.json({ error: "Not found" }, 404);
      size = s.size;
    } catch {
      return c.json({ error: "Not found" }, 404);
    }

    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
    const headers: Record<string, string> = {
      "Content-Type": type,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "bytes",
    };

    // Range support so <video> can seek.
    const range = c.req.header("range");
    const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      headers["Content-Length"] = String(end - start + 1);
      const body = Readable.toWeb(createReadStream(full, { start, end })) as ReadableStream;
      return new Response(body, { status: 206, headers });
    }

    headers["Content-Length"] = String(size);
    const body = Readable.toWeb(createReadStream(full)) as ReadableStream;
    return new Response(body, { status: 200, headers });
  });

  return app;
}
