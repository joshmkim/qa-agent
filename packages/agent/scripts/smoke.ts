/**
 * Offline smoke test: runs the real browser + tools + loop against a tiny
 * local storefront with planted bugs, driven by a scripted ModelClient so no
 * API key is needed.
 *
 *   pnpm --filter @qa-agent/agent smoke
 *
 * Planted bugs: /api/promo returns 500; the cart total ignores tax
 * (invariant violation); clicking "Wishlist" throws an uncaught exception;
 * /admin is inside the blast radius and must be blocked.
 */
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ContextBundle } from "@qa-agent/shared-types";
import { runAgent } from "../src/index";
import type { ModelClient, ModelRequest, ModelResponse, ToolCall } from "../src/model/types";

const PAGE = `<!doctype html><html><head><title>Shoe Store (beta)</title></head><body>
<h1>Shoe Store</h1>
<nav><a href="/">Home</a> <a href="/cart">Cart</a> <a href="/admin">Admin</a></nav>
<div id="consent" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div style="background:#fff;padding:20px;margin:100px auto;width:300px">
  We use cookies. <button id="accept">Accept all</button></div></div>
<main>
  <h2>Products</h2>
  <ul>
    <li>Runner 3000 $48.00 <button data-testid="add-runner" onclick="add('runner',48)">Add to cart</button></li>
    <li>Trail Pro $80.00 <button data-testid="add-trail" onclick="add('trail',80)">Add to cart</button></li>
  </ul>
  <button id="wish" onclick="wishlist()">Wishlist</button>
  <form id="search" onsubmit="event.preventDefault(); location.href='/search?q='+encodeURIComponent(q.value)">
    <label for="q">Search</label><input id="q" name="q" placeholder="Search shoes"><button type="submit">Go</button>
  </form>
</main>
<script>
  function add(id, price) {
    const cart = JSON.parse(localStorage.getItem('cart') || '[]'); cart.push({id, price});
    localStorage.setItem('cart', JSON.stringify(cart));
    document.getElementById('consent') && (document.getElementById('consent').style.display='none');
    fetch('/api/cart', {method:'POST', body: JSON.stringify(cart)});
  }
  function wishlist() { throw new Error('wishlist service is undefined'); }
  document.getElementById('accept').onclick = () => document.getElementById('consent').remove();
</script></body></html>`;

const CART = `<!doctype html><html><head><title>Cart</title></head><body>
<h1>Your cart</h1>
<table id="cart"><tbody></tbody></table>
<p>Tax: <span id="tax"></span></p>
<p>Total: <span data-testid="total"></span></p>
<form onsubmit="event.preventDefault(); fetch('/api/promo?code='+code.value).then(r=>{document.getElementById('msg').textContent='HTTP '+r.status})">
  <label>Promo code <input id="code" name="code"></label><button>Apply promo</button>
</form>
<p id="msg"></p>
<a href="/">Continue shopping</a>
<script>
  const cart = JSON.parse(localStorage.getItem('cart') || '[]');
  const tb = document.querySelector('#cart tbody');
  let sum = 0;
  for (const it of cart) { sum += it.price; tb.insertAdjacentHTML('beforeend', '<tr><td>'+it.id+'</td><td>$'+it.price.toFixed(2)+'</td></tr>'); }
  const tax = sum * 0.1;
  document.getElementById('tax').textContent = '$' + tax.toFixed(2);
  // BUG: total ignores tax
  document.querySelector('[data-testid=total]').textContent = '$' + sum.toFixed(2);
</script></body></html>`;

function startApp(): Promise<{ url: string; close: () => void }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/") return res.end(PAGE);
    if (url.pathname === "/cart") return res.end(CART);
    if (url.pathname === "/search") return res.end(`<h1>Results for ${url.searchParams.get("q")}</h1><a href="/">Home</a>`);
    if (url.pathname === "/api/cart") return res.end("{}");
    if (url.pathname === "/api/promo") {
      res.statusCode = 500;
      return res.end("promo service exploded");
    }
    if (url.pathname.startsWith("/admin")) return res.end("<h1>ADMIN</h1><p>You should never see this</p>");
    res.statusCode = 404;
    res.end("nope");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/** Replays a fixed list of tool calls, then calls done. */
class ScriptedModel implements ModelClient {
  readonly name = "scripted";
  private i = 0;
  readonly seen: string[] = [];
  constructor(private readonly script: Array<Omit<ToolCall, "id">>) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const last = req.messages[req.messages.length - 1];
    if (last && last.role === "user" && "toolResults" in last) {
      for (const r of last.toolResults) this.seen.push(r.content);
    }
    const next = this.script[this.i++];
    if (!next) return { text: "done", toolCalls: [], stopReason: "end_turn" };
    return { toolCalls: [{ id: `call_${this.i}`, ...next }], stopReason: "tool_use" };
  }
}

function bundleFor(baseUrl: string): ContextBundle {
  return {
    runId: "run_smoke",
    agentId: "agent_smoke_1",
    persona: {
      id: "p1",
      name: "Methodical Maya",
      description: "Verifies totals and promo flows.",
      disposition: "methodical",
      focusAreas: ["s_cart", "s_cart_promo"],
    },
    change: {
      baseSha: "aaaaaaa1",
      headSha: "bbbbbbb2",
      commitCount: 2,
      filesChanged: 2,
      compareStatus: "ahead",
      pullRequests: [
        {
          number: 42,
          title: "Recompute cart total client-side",
          body: "Moves total computation to the cart page. Fixes #41.",
          author: "dev",
          labels: ["cart"],
          linkedIssues: ["#41"],
          url: "https://github.com/x/y/pull/42",
          mergedAt: "2026-09-12T10:00:00Z",
          filesChanged: 2,
          additions: 12,
          deletions: 3,
        },
      ],
      changedFiles: [
        { path: "web/cart/total.ts", status: "modified", additions: 10, deletions: 3, patch: "@@ -1,3 +1,10 @@\n-const total = sum + tax;\n+const total = sum;" },
        { path: "api/promo.ts", status: "modified", additions: 2, deletions: 0 },
      ],
    },
    product: {
      productName: "Shoe Store",
      intent: "Sell shoes with a working cart and checkout.",
      stakeholders: ["Commerce team"],
      manifestVersion: "1",
      surfaces: [
        { id: "s_home", kind: "page", name: "Home", locator: "/" },
        { id: "s_cart", kind: "page", name: "Cart", locator: "/cart", touchedByChange: true },
        { id: "s_cart_promo", kind: "form", name: "Promo code form", locator: "[name=code]", touchedByChange: true },
        { id: "s_search", kind: "page", name: "Search results", locator: "/search" },
      ],
      invariants: [
        { id: "inv_cart_total", statement: "Cart total equals sum of line items plus tax.", severityOnViolation: "P0" },
      ],
    },
    environment: {
      stageName: "beta",
      baseUrl,
      credentialsRef: "secrets://none",
      blastRadiusBoundaries: ["/admin"],
    },
    budgetSeconds: 120,
    saturatedSurfaceIds: ["s_search"],
  };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok   ${msg}`);
  }
}

async function main() {
  const app = await startApp();
  const bundle = bundleFor(app.url);
  const model = new ScriptedModel([
    { name: "navigate", args: { url: "/" } },
    { name: "click", args: { target: "add-runner" } }, // consent overlay covers it -> recovery path
    { name: "click", args: { target: "Wishlist" } }, // uncaught exception -> auto-filed
    { name: "type", args: { target: "Search shoes", text: "trail", submit: true } },
    { name: "go_back", args: {} },
    { name: "navigate", args: { url: "/admin" } }, // blast radius -> refused
    { name: "click", args: { target: "Cart" } },
    { name: "read_text", args: { target: "testid=total" } },
    { name: "check_invariant", args: { invariantId: "inv_cart_total", holds: false, observation: "total $48.00 but tax $4.80 shown", surfaceId: "s_cart" } },
    { name: "type", args: { target: "Promo code", text: "SAVE10" } },
    { name: "click", args: { target: "Apply promo" } }, // 500 -> auto-filed
    { name: "click", args: { target: "Nonexistent button" } }, // not found -> suggestions
    { name: "call_api", args: { method: "GET", url: "/api/promo?code=X" } },
    { name: "mark_surface_visited", args: { surfaceIds: ["s_cart", "s_cart_promo", "bogus"] } },
    { name: "file_finding", args: { severity: "P1", title: "Promo apply returns 500", summary: "Clicking Apply promo shows HTTP 500", surfaceId: "s_cart_promo", oracle: "hard-error", signature: "GET /api/promo 500" } },
    { name: "screenshot", args: { label: "cart" } },
    { name: "done", args: { summary: "Covered cart and promo.", untested: [] } },
  ]);

  const result = await runAgent(bundle, { model, headless: true, recordVideo: true, log: (m) => console.log(`   [agent] ${m}`) });
  app.close();

  const seen = model.seen.join("\n---\n");
  const titles = result.findings.map((f) => `${f.severity} ${f.title}`);
  console.log("\nfindings:\n  " + titles.join("\n  "));
  console.log(`trace: ${result.trace.length} steps, outcomes: ${result.trace.map((s) => s.outcome[0]).join("")}\n`);

  assert(result.status === "completed", "agent completed");
  assert(result.trace.length === 17, `17 steps recorded (got ${result.trace.length})`);
  assert(result.trace[1]?.outcome === "recovered" || result.trace[1]?.outcome === "ok", "click under consent overlay recovered");
  assert(/Refused: .*blast-radius/.test(seen), "navigate to /admin refused");
  assert(/Results for trail/.test(seen) || /search\?q=trail/.test(seen), "type+submit navigated to search");
  assert(/No element matched "Nonexistent button"/.test(seen) && /Visible interactive elements/.test(seen), "not-found failure lists visible elements");
  assert(/\$48\.00/.test(seen), "read_text returned the total");
  assert(/HTTP 500/.test(seen), "call_api reported 500");
  assert(/Ignored unknown ids: bogus/.test(seen), "mark_surface_visited rejected unknown id");
  assert(result.visitedSurfaceIds.sort().join() === "s_cart,s_cart_promo", "visited surfaces recorded");
  assert(result.checkedInvariantIds.includes("inv_cart_total"), "invariant check recorded");
  assert(result.findings.some((f) => f.oracle === "invariant" && f.severity === "P0" && f.invariantId === "inv_cart_total"), "invariant violation filed at P0");
  assert(result.findings.some((f) => f.oracle === "hard-error" && /Uncaught exception: .*wishlist/.test(f.title)), "uncaught exception auto-filed");
  assert(result.findings.some((f) => f.oracle === "hard-error" && /HTTP 500 from GET .*\/api\/promo/.test(f.title)), "500 auto-filed");
  assert(result.findings.filter((f) => /api\/promo/.test(f.title) && f.oracle === "hard-error").length <= 2, "repeat 500s deduped by signature");
  assert(result.findings.some((f) => f.title === "Promo apply returns 500"), "explicit file_finding stored");
  assert(result.findings.every((f) => f.reproSteps.length > 0 && f.evidence.length > 0), "every finding has repro steps and evidence");
  assert(result.findings.every((f) => f.runId === "run_smoke" && f.agentId === "agent_smoke_1" && f.dedupeKey.length === 24), "finding identity fields set");
  assert(result.trace.some((s) => s.screenshotId), "screenshot step recorded screenshotId");
  assert(/Hard errors since last step/.test(seen), "hard errors surfaced in tool results");
  const videoSize = result.videoPath ? (await stat(result.videoPath).catch(() => undefined))?.size ?? 0 : 0;
  assert(result.videoPath?.endsWith(".webm") && videoSize > 10_000, `session video recorded (${result.videoPath}, ${videoSize} bytes)`);

  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
