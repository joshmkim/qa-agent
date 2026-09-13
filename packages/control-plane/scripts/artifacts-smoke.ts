/**
 * Offline check that artifact URLs round-trip: write files where an agent
 * would, build the URL the agent would store in Evidence.content, fetch it
 * through the real route (including a Range request, which <video> needs),
 * and confirm traversal attempts are rejected.
 *
 *   pnpm --filter @qa-agent/control-plane artifacts-smoke
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { artifactRoutes, createArtifactStore } from "../src/artifacts";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok   ${msg}`);
}

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), "qa-artifacts-"));
  const publicUrl = "http://cp.local:3001";
  const store = createArtifactStore(root, publicUrl);
  const app = new Hono().route("/api/artifacts", artifactRoutes(root));

  const dir = store.dirFor("run_abc", "run_abc-a001");
  await mkdir(dir, { recursive: true });
  const png = path.join(dir, "shot_001.png");
  const webm = path.join(dir, "page@deadbeef.webm");
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
  await writeFile(webm, Buffer.alloc(1000, 7));

  const pngUrl = store.urlFor("run_abc", "run_abc-a001", png);
  assert(pngUrl === `${publicUrl}/api/artifacts/run_abc/run_abc-a001/shot_001.png`, `url shape: ${pngUrl}`);

  const get = (u: string, headers: Record<string, string> = {}) => app.request(u.replace(publicUrl, ""), { headers });

  const r1 = await get(pngUrl);
  assert(r1.status === 200 && r1.headers.get("content-type") === "image/png" && (await r1.arrayBuffer()).byteLength === 8, "png served with content-type and full body");

  const videoUrl = store.urlFor("run_abc", "run_abc-a001", webm);
  const r2 = await get(videoUrl, { range: "bytes=100-199" });
  assert(r2.status === 206 && r2.headers.get("content-range") === "bytes 100-199/1000" && (await r2.arrayBuffer()).byteLength === 100, "range request -> 206 with correct slice");
  const r3 = await get(videoUrl, { range: "bytes=900-" });
  assert(r3.status === 206 && r3.headers.get("content-length") === "100", "open-ended range");
  const r4 = await get(videoUrl, { range: "bytes=5000-" });
  assert(r4.status === 416, "out-of-range -> 416");

  const r5 = await get(`${publicUrl}/api/artifacts/run_abc/run_abc-a001/missing.png`);
  assert(r5.status === 404, "missing file -> 404");
  const r6 = await get(`${publicUrl}/api/artifacts/run_abc/..%2F..%2Fetc/passwd`);
  assert(r6.status === 400 || r6.status === 404, `traversal rejected (${r6.status})`);
  let threw = false;
  try {
    store.dirFor("../evil", "a");
  } catch {
    threw = true;
  }
  assert(threw, "dirFor rejects bad segments");

  await rm(root, { recursive: true, force: true });
  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
