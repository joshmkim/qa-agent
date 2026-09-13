/**
 * Fixture findings for TrentK014/nike-storefront beta, checked against the
 * Vercel beta deployment on 2026-09-13:
 *   - "Save 20% with code: YR24" banner, but /api/discount/validate rejects it   (still live)
 *   - <title> is "Create Next App" on every page                                  (still live)
 *   - Invincible 3 card showed -35% while every stock row had sale_percent 0      (gone after the reseed in #7's window)
 *   - GET /api/shoes/<unknown id>/stock returned 500                              (now 200 [] / shoe page 404)
 * Run #1 (before the reseed) has all four; run #2 has the two that remain.
 * Repro traces and evidence are fixtures; screenshots are captured from beta.
 */
import type { Finding, ActionStep } from "@qa-agent/shared-types";

const step = (
  index: number,
  kind: ActionStep["kind"],
  description: string,
  args: ActionStep["args"],
  outcome: ActionStep["outcome"] = "ok",
  durationMs = 420,
  screenshotId?: string,
): ActionStep => ({ index, kind, description, args, outcome, durationMs, screenshotId });

/** Seeded catalog ids are UUIDs of the form 00000000-0000-4000-8000-00000000000N. */
const SHOE = {
  pegasusTrail5: "00000000-0000-4000-8000-000000000001",
  airMax90: "00000000-0000-4000-8000-000000000002",
  invincible3: "00000000-0000-4000-8000-000000000003",
  unknown: "00000000-0000-4000-8000-0000000000ff",
};

const VALIDATE_YR24 = 'POST /api/discount/validate {"code":"YR24"}\n-> 200 {"valid":false,"message":"Invalid code"}';

const yr24Steps = (shoeId: string, size: string): ActionStep[] => [
  step(1, "navigate", "Open home", { url: "/" }, "ok", 1380, "home"),
  step(2, "read_text", "Read promo bar", { selector: "nav" }, "ok", 120),
  step(3, "navigate", "Open Pegasus Trail 5", { url: `/shoe/${shoeId}` }, "ok", 1210),
  step(4, "click", `Pick size M ${size}`, { selector: `button:has-text('M ${size}')` }),
  step(5, "click", "Add to Cart", { selector: "button:has-text('Add to Cart')" }, "ok", 860),
  step(6, "navigate", "Go to checkout", { url: "/checkout" }, "ok", 1140),
  step(7, "type", "Enter discount code", { selector: "input[placeholder='Enter code']", value: "YR24" }),
  step(8, "click", "Apply", { selector: "button:has-text('Apply')" }, "ok", 640, "checkout"),
  step(9, "read_text", "Read discount message", { selector: "form" }, "ok", 90),
  step(10, "call_api", "POST /api/discount/validate", { method: "POST", path: "/api/discount/validate", body: '{"code":"YR24"}' }, "failed", 310),
  step(11, "file_finding", "Advertised code not honoured", { severity: "P1" }, "ok", 30),
];

export const findings: Finding[] = [
  // ---------------- run #2 (#4 merge -> #7 merge) ----------------
  {
    id: "fnd_001",
    runId: "run_beta_2",
    agentId: "run_beta-a001",
    personaName: "Methodical Maya",
    severity: "P1",
    title: "Advertised discount code YR24 is rejected at checkout",
    summary:
      "The promo bar on every page reads \"New here? Save 20% with code: YR24\", but entering YR24 at checkout shows \"Invalid code\" and POST /api/discount/validate answers { valid: false }. Every shopper who follows the banner loses the advertised discount.",
    surfaceId: "checkout",
    oracle: "llm-judgment",
    dedupeKey: "checkout:discount:YR24-rejected",
    reproSteps: yr24Steps(SHOE.pegasusTrail5, "10"),
    evidence: [
      { id: "ev_001_1", kind: "screenshot", label: "Promo bar: New here? Save 20% with code: YR24", content: "/mock/shots/nike-home.png", capturedAt: "2026-09-13T20:58:40Z" },
      { id: "ev_001_2", kind: "screenshot", label: "Checkout after applying YR24", content: "/mock/shots/nike-checkout.png", capturedAt: "2026-09-13T20:59:31Z" },
      { id: "ev_001_3", kind: "network", label: "Validate endpoint rejects the code", content: VALIDATE_YR24, capturedAt: "2026-09-13T20:59:32Z" },
    ],
    status: "reproduced",
    triage: {
      reproducedFromCleanSession: true,
      duplicateCount: 3,
      note: "Also hit by Impatient Ivan and Chaos Kai from fresh sessions. No PR in this window touches discount handling; the seeded discount_codes table (PR #5) has no YR24 row while the promo bar copy is static. Pre-existing on beta (also fnd_006 in run #1), not a regression of #7.",
    },
    reportedAt: "2026-09-13T20:59:35Z",
  },
  {
    id: "fnd_002",
    runId: "run_beta_2",
    agentId: "run_beta-a004",
    personaName: "Diligent Dana",
    severity: "P3",
    title: "Document title is still \"Create Next App\" on every page",
    summary: "The <title> is the create-next-app default on the home, category, shoe, bag and checkout pages. Cosmetic, but visible in every browser tab and in search results.",
    surfaceId: "layout-nav",
    oracle: "llm-judgment",
    dedupeKey: "layout-nav:title:create-next-app",
    reproSteps: [
      step(1, "navigate", "Open home", { url: "/" }, "ok", 1260, "home"),
      step(2, "read_dom", "Read document title", { selector: "title" }, "ok", 40),
      step(3, "navigate", "Open Men", { url: "/men" }, "ok", 980),
      step(4, "read_dom", "Read document title", { selector: "title" }, "ok", 40),
    ],
    evidence: [
      { id: "ev_002_1", kind: "log", label: "Titles", content: "/      -> Create Next App\n/men   -> Create Next App\n/cart  -> Create Next App", capturedAt: "2026-09-13T20:57:30Z" },
    ],
    status: "reproduced",
    triage: { reproducedFromCleanSession: true, duplicateCount: 0, note: "Judged against the product intent (a branded storefront). src/app/layout.tsx is untouched in this window." },
    reportedAt: "2026-09-13T20:57:33Z",
  },
  {
    id: "fnd_003",
    runId: "run_beta_2",
    agentId: "run_beta-a010",
    personaName: "Impatient Ivan",
    severity: "P1",
    title: "Banner promo code YR24 does not work",
    summary: "Typed the code from the banner at checkout, got Invalid code. Same as fnd_001.",
    surfaceId: "checkout",
    oracle: "llm-judgment",
    dedupeKey: "checkout:discount:YR24-rejected",
    reproSteps: [
      step(1, "navigate", "Open home", { url: "/" }, "ok", 1310),
      step(2, "navigate", "Open Air Max 90", { url: `/shoe/${SHOE.airMax90}` }, "ok", 1150),
      step(3, "click", "Pick size M 9", { selector: "button:has-text('M 9')" }),
      step(4, "click", "Add to Cart", { selector: "button:has-text('Add to Cart')" }, "ok", 830),
      step(5, "navigate", "Go to checkout", { url: "/checkout" }, "ok", 1090),
      step(6, "type", "Enter YR24", { selector: "input[placeholder='Enter code']", value: "YR24" }),
      step(7, "press_key", "Enter", { key: "Enter" }, "ok", 610),
    ],
    evidence: [],
    status: "duplicate",
    triage: { reproducedFromCleanSession: true, duplicateOf: "fnd_001", duplicateCount: 0 },
    reportedAt: "2026-09-13T21:00:12Z",
  },

  // ---------------- run #1 (#3 merge -> #4 merge, before the reseed) ----------------
  {
    id: "fnd_004",
    runId: "run_beta_1",
    agentId: "run_beta-a002",
    personaName: "Careful Chen",
    severity: "P1",
    title: "Invincible 3 card shows -35% while every stock row has sale_percent 0",
    summary:
      "The home product card for Invincible 3 renders a -35% sale sticker next to the $180 price. GET /api/shoes/:id/stock returns sale_percent 0 for all sizes and the shoe page shows no sticker and the full $180, so the card advertises a discount the bag never applies.",
    surfaceId: "home",
    oracle: "invariant",
    invariantId: "sale-price-parity",
    dedupeKey: "home:sale-price-parity:invincible-3",
    reproSteps: [
      step(1, "navigate", "Open home", { url: "/" }, "ok", 1290, "home"),
      step(2, "read_text", "Read Invincible 3 card sticker and price", { selector: "[data-testid=sale-sticker]" }, "ok", 110),
      step(3, "call_api", "GET stock for Invincible 3", { method: "GET", path: `/api/shoes/${SHOE.invincible3}/stock` }, "ok", 280),
      step(4, "navigate", "Open Invincible 3", { url: `/shoe/${SHOE.invincible3}` }, "ok", 1170, "pdp"),
      step(5, "read_text", "Read shoe page price and stickers", { selector: "main" }, "ok", 90),
      step(6, "click", "Pick size M 9", { selector: "button:has-text('M 9')" }),
      step(7, "click", "Add to Cart", { selector: "button:has-text('Add to Cart')" }, "ok", 820),
      step(8, "navigate", "Open bag", { url: "/cart" }, "ok", 1040),
      step(9, "read_text", "Read bag line price", { selector: "main" }, "ok", 80),
      step(10, "check_invariant", "Card sticker matches bag unit price", { invariant: "sale-price-parity" }, "failed", 40),
    ],
    evidence: [
      { id: "ev_004_1", kind: "screenshot", label: "Home grid with sale stickers", content: "/mock/shots/nike-home.png", capturedAt: "2026-09-13T19:47:52Z" },
      {
        id: "ev_004_2",
        kind: "network",
        label: "Stock rows all sale_percent 0",
        content: `GET /api/shoes/${SHOE.invincible3}/stock\n-> 200 [{"size":"7","color":"Black","quantity":10,"reserved_quantity":0,"sale_percent":0},{"size":"9","color":"Black","quantity":10,"reserved_quantity":0,"sale_percent":0},{"size":"12","color":"Black","quantity":0,"reserved_quantity":0,"sale_percent":0}, ...]`,
        capturedAt: "2026-09-13T19:47:53Z",
      },
      { id: "ev_004_3", kind: "screenshot", label: "Shoe page: $180, no sticker", content: "/mock/shots/nike-pdp-invincible.png", capturedAt: "2026-09-13T19:48:20Z" },
    ],
    status: "confirmed",
    triage: {
      reproducedFromCleanSession: true,
      duplicateCount: 1,
      suspectedPrNumber: 4,
      note: "Attribution is weak: #4 only added a test id to SaleSticker.tsx. The card's sticker came from stale catalog data; did not reproduce in run #2 after the beta database was reseeded (b423c81).",
    },
    reportedAt: "2026-09-13T19:48:24Z",
  },
  {
    id: "fnd_005",
    runId: "run_beta_1",
    agentId: "run_beta-a008",
    personaName: "Fuzzer Fatima",
    severity: "P2",
    title: "GET /api/shoes/:id/stock returns 500 for an unknown shoe id",
    summary:
      "Requesting stock for a well-formed UUID that does not exist returned 500 with a database error body instead of 404, and the shoe page for the same id rendered a server error.",
    surfaceId: "api-stock",
    oracle: "hard-error",
    dedupeKey: "api-stock:500:unknown-id",
    reproSteps: [
      step(1, "call_api", "GET stock for non-existent shoe", { method: "GET", path: `/api/shoes/${SHOE.unknown}/stock` }, "failed", 540),
      step(2, "navigate", "Open shoe page for the same id", { url: `/shoe/${SHOE.unknown}` }, "failed", 1320),
      step(3, "get_console_errors", "Read console", {}, "ok", 60),
    ],
    evidence: [
      { id: "ev_005_1", kind: "network", label: "500 with database error body", content: `GET /api/shoes/${SHOE.unknown}/stock\n-> 500 {"error":"JSON object requested, multiple (or no) rows returned"}`, capturedAt: "2026-09-13T19:51:05Z" },
    ],
    status: "confirmed",
    triage: {
      reproducedFromCleanSession: true,
      duplicateCount: 0,
      note: ".single() on an empty result threw and the route did not map it to 404. Did not reproduce in run #2: the endpoint now returns 200 [] and the shoe page 404s.",
    },
    reportedAt: "2026-09-13T19:51:10Z",
  },
  {
    id: "fnd_006",
    runId: "run_beta_1",
    agentId: "run_beta-a001",
    personaName: "Methodical Maya",
    severity: "P1",
    title: "Advertised discount code YR24 is rejected at checkout",
    summary:
      "The promo bar advertises \"New here? Save 20% with code: YR24\"; applying it at checkout shows \"Invalid code\" and POST /api/discount/validate answers { valid: false }.",
    surfaceId: "checkout",
    oracle: "llm-judgment",
    dedupeKey: "checkout:discount:YR24-rejected",
    reproSteps: yr24Steps(SHOE.pegasusTrail5, "9"),
    evidence: [
      { id: "ev_006_1", kind: "screenshot", label: "Checkout after applying YR24", content: "/mock/shots/nike-checkout.png", capturedAt: "2026-09-13T19:49:02Z" },
      { id: "ev_006_2", kind: "network", label: "Validate endpoint rejects the code", content: VALIDATE_YR24, capturedAt: "2026-09-13T19:49:02Z" },
    ],
    status: "confirmed",
    triage: { reproducedFromCleanSession: true, duplicateCount: 1, note: "Not attributable to #4 (test id only). Still present in run #2 as fnd_001." },
    reportedAt: "2026-09-13T19:49:05Z",
  },
];
