import type { Locator, Page } from "playwright";
import { formatSnapshot, snapshotDom } from "../browser/snapshot";
import { resolve, type Resolved } from "./locate";
import {
  bool,
  fail,
  num,
  ok,
  requireStr,
  str,
  truncate,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "./types";

const TARGET_DESCRIPTION =
  'Element to act on. Use a ref from read_dom ("e12"), visible text ("Add to cart"), a label/placeholder ' +
  '("Email"), a CSS selector ("#checkout"), or an explicit prefix (text=, role=button[name=Buy], testid=, label=, css=).';

const targetSchema = {
  type: "object",
  properties: {
    target: { type: "string", description: TARGET_DESCRIPTION },
    nth: { type: "integer", description: "0-based index when several elements match. Omit to take the first visible one." },
  },
  required: ["target"],
  additionalProperties: false,
} as const;

// Browser-side snippets are plain JS source (see browser/snapshot.ts for why),
// typed at the call site via Playwright's string-evaluate overloads.
const SCROLL_SOURCE = new Function(
  "a",
  'if (a.dir === "top") window.scrollTo(0, 0); else if (a.dir === "bottom") window.scrollTo(0, document.body.scrollHeight); else window.scrollBy(0, a.dir === "up" ? -a.px : a.px);',
) as (a: { dir: string; px: number }) => void;
const SCROLL_POSITION_SOURCE = new Function(
  "return { y: Math.round(window.scrollY), max: Math.round(document.body.scrollHeight - window.innerHeight) };",
) as () => { y: number; max: number };
const BODY_TEXT_SOURCE = new Function("return document.body ? document.body.innerText : '';") as () => string;

/** Wait a beat for the app to react, without hanging on long-polling pages. */
async function settle(page: Page, ms = 1_500): Promise<void> {
  await Promise.race([page.waitForLoadState("load").catch(() => undefined), page.waitForTimeout(ms)]);
  await page.waitForTimeout(150);
}

function pageState(page: Page): string {
  return `Now at ${page.url()}`;
}

/**
 * A resolve failure carries the visible interactive elements so the model
 * can pick a real target instead of guessing again.
 */
async function notFound(ctx: ToolContext, target: string): Promise<ToolResult> {
  const snap = await snapshotDom(ctx.session.page, { maxElements: 30, maxText: 0 }).catch(() => undefined);
  const hint = snap
    ? `\nVisible interactive elements right now:\n${snap.elements
        .map((e) => `  [${e.ref}] ${e.role} "${e.name}"${e.disabled ? " DISABLED" : ""}`)
        .join("\n")}`
    : "";
  return fail(`No element matched "${target}" on ${ctx.session.page.url()}. If it was a ref, refs reset on navigation: call read_dom again.${hint}`);
}

function describeResolved(r: Resolved): string {
  return `${r.strategy}${r.ambiguous ? `, ${r.matches} matches, took first visible` : ""}`;
}

/** Common cookie/consent/modal dismissers tried when a click is blocked. */
const OVERLAY_BUTTONS = /^(accept( all)?( cookies)?|i agree|agree|got it|ok|okay|close|dismiss|no thanks|continue|allow( all)?)$/i;

async function dismissOverlays(page: Page): Promise<string | undefined> {
  await page.keyboard.press("Escape").catch(() => undefined);
  const buttons = page.getByRole("button");
  const count = await buttons.count().catch(() => 0);
  for (let i = 0; i < Math.min(count, 40); i++) {
    const b = buttons.nth(i);
    const name = ((await b.textContent().catch(() => "")) ?? "").trim();
    if (OVERLAY_BUTTONS.test(name) && (await b.isVisible().catch(() => false))) {
      await b.click({ timeout: 2_000 }).catch(() => undefined);
      return name;
    }
  }
  return undefined;
}

async function clickWithRecovery(locator: Locator, page: Page): Promise<{ how: string; recovered: boolean }> {
  await locator.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
  try {
    await locator.click({ timeout: 5_000 });
    return { how: "click", recovered: false };
  } catch (first) {
    const msg = first instanceof Error ? first.message : String(first);
    // Something is covering the element: clear overlays and retry once.
    if (/intercepts pointer events|not visible|outside of the viewport|element is not attached/i.test(msg)) {
      const dismissed = await dismissOverlays(page);
      try {
        await locator.click({ timeout: 4_000 });
        return { how: dismissed ? `dismissed "${dismissed}" overlay then click` : "retry click after Escape", recovered: true };
      } catch {
        /* fall through */
      }
    }
    // Last resort: dispatch the click without actionability checks.
    try {
      await locator.click({ timeout: 3_000, force: true });
      return { how: "force click", recovered: true };
    } catch {
      await locator.dispatchEvent("click", undefined, { timeout: 3_000 });
      return { how: "dispatched click event", recovered: true };
    }
  }
}

export const navigate: ToolDefinition = {
  name: "navigate",
  description:
    "Load a URL. Relative paths resolve against the environment base URL. Returns the final URL, HTTP status, title and a page snapshot.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: 'Absolute URL or path like "/cart".' },
    },
    required: ["url"],
    additionalProperties: false,
  },
  describe: (a) => `Navigate to ${str(a, "url") ?? "?"}`,
  async execute(args, ctx) {
    const { session } = ctx;
    const target = session.resolveUrl(requireStr(args, "url"));
    if (session.isOutOfBounds(target)) {
      return fail(`Refused: ${target} is inside a blast-radius boundary (${ctx.bundle.environment.blastRadiusBoundaries.join(", ")}). Stay within the allowed surfaces.`);
    }
    let recovered = false;
    let status: number | undefined;
    try {
      const res = await session.page.goto(target, { waitUntil: "domcontentloaded" });
      status = res?.status();
      await settle(session.page, 2_500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Timeout/i.test(msg) && session.page.url() !== "about:blank") {
        recovered = true; // partial load is still explorable
      } else {
        return fail(`Navigation to ${target} failed: ${truncate(msg, 300)}`);
      }
    }
    const snap = await snapshotDom(session.page, { maxElements: 60 });
    const lines = [
      `${recovered ? "Loaded (partially, load event timed out)" : "Loaded"} ${session.page.url()}${status !== undefined ? ` (HTTP ${status})` : ""}`,
    ];
    if (status !== undefined && status >= 400) lines.push(`WARNING: server returned ${status}. Consider file_finding if this page should exist.`);
    lines.push(formatSnapshot(snap));
    return ok(lines.join("\n"), { recovered });
  },
};

export const click: ToolDefinition = {
  name: "click",
  description:
    "Click an element. Recovers from overlays, off-screen elements and slow renders automatically. Returns what changed (URL, title) and a fresh snapshot when the page navigated.",
  inputSchema: targetSchema,
  describe: (a) => `Click ${str(a, "target") ?? "?"}`,
  async execute(args, ctx) {
    const { session } = ctx;
    const page = session.page;
    const target = requireStr(args, "target");
    const before = page.url();
    const resolved = await resolve(page, target, { nth: typeof args.nth === "number" ? args.nth : undefined });
    if (!resolved) return notFound(ctx, target);

    if (await resolved.locator.isDisabled().catch(() => false)) {
      return fail(`"${target}" (${resolved.strategy}) is disabled; clicking it does nothing. If it should be enabled in this state, that may be a finding.`);
    }

    let how: string;
    let recovered: boolean;
    try {
      ({ how, recovered } = await clickWithRecovery(resolved.locator, page));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Could not click "${target}" (${describeResolved(resolved)}): ${truncate(msg, 300)}. Try read_dom to get a fresh ref, or a different target.`);
    }
    await settle(session.page);

    const after = session.page.url();
    const navigated = after !== before;
    const out = [`Clicked "${target}" via ${how} (${describeResolved(resolved)}). ${navigated ? `Navigated: ${before} -> ${after}` : pageState(session.page)}`];
    if (navigated) {
      const snap = await snapshotDom(session.page, { maxElements: 60, maxText: 800 }).catch(() => undefined);
      if (snap) out.push(formatSnapshot(snap));
    } else {
      // Same URL: surface what changed instead of the whole page.
      const snap = await snapshotDom(session.page, { maxElements: 40, maxText: 500 }).catch(() => undefined);
      if (snap) out.push(formatSnapshot(snap));
    }
    return ok(out.join("\n"), { recovered });
  },
};

export const type: ToolDefinition = {
  name: "type",
  description:
    "Type into an input, textarea, or contenteditable. Clears existing content unless append=true. Set submit=true to press Enter afterwards.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: TARGET_DESCRIPTION },
      text: { type: "string" },
      append: { type: "boolean", description: "Keep existing value and append." },
      submit: { type: "boolean", description: "Press Enter after typing." },
      nth: { type: "integer" },
    },
    required: ["target", "text"],
    additionalProperties: false,
  },
  describe: (a) => `Type "${truncate(str(a, "text") ?? "", 40)}" into ${str(a, "target") ?? "?"}`,
  async execute(args, ctx) {
    const page = ctx.session.page;
    const target = requireStr(args, "target");
    const text = typeof args.text === "string" ? args.text : String(args.text ?? "");
    const resolved = await resolve(page, target, { nth: typeof args.nth === "number" ? args.nth : undefined });
    if (!resolved) return notFound(ctx, target);
    const el = resolved.locator;
    let recovered = false;
    try {
      await el.scrollIntoViewIfNeeded({ timeout: 3_000 }).catch(() => undefined);
      if (bool(args, "append", false)) {
        await el.click({ timeout: 3_000 });
        await el.pressSequentially(text, { timeout: 10_000 });
      } else {
        try {
          await el.fill(text, { timeout: 4_000 });
        } catch {
          // Not a fillable control (custom widget); focus and type keys.
          recovered = true;
          await el.click({ timeout: 3_000, force: true });
          await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
          await page.keyboard.type(text);
        }
      }
      if (bool(args, "submit", false)) {
        await el.press("Enter", { timeout: 3_000 }).catch(() => page.keyboard.press("Enter"));
        await settle(page);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`Could not type into "${target}" (${describeResolved(resolved)}): ${truncate(msg, 300)}`);
    }
    const value = await el.inputValue({ timeout: 1_000 }).catch(() => undefined);
    return ok(
      `Typed into "${target}" (${describeResolved(resolved)}${recovered ? ", via keyboard fallback" : ""}).${value !== undefined ? ` Field value now: "${truncate(value, 80)}"` : ""} ${pageState(page)}`,
      { recovered },
    );
  },
};

export const pressKey: ToolDefinition = {
  name: "press_key",
  description: 'Press a keyboard key or chord, e.g. "Enter", "Escape", "Tab", "ArrowDown", "ControlOrMeta+A". Optionally focus a target first.',
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      target: { type: "string", description: "Optional element to focus before pressing." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  describe: (a) => `Press ${str(a, "key") ?? "?"}`,
  async execute(args, ctx) {
    const page = ctx.session.page;
    const key = requireStr(args, "key");
    const target = str(args, "target");
    if (target) {
      const resolved = await resolve(page, target);
      if (!resolved) return notFound(ctx, target);
      await resolved.locator.focus({ timeout: 3_000 }).catch(() => undefined);
    }
    const before = page.url();
    try {
      await page.keyboard.press(key);
    } catch (err) {
      return fail(`Could not press "${key}": ${err instanceof Error ? err.message : String(err)}`);
    }
    await settle(page, 800);
    return ok(`Pressed ${key}. ${page.url() !== before ? `Navigated to ${page.url()}` : pageState(page)}`);
  },
};

export const selectOption: ToolDefinition = {
  name: "select_option",
  description: "Choose an option in a <select> by visible label or value. For custom dropdowns, use click on the trigger and then on the option instead.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: TARGET_DESCRIPTION },
      option: { type: "string", description: "Option label or value." },
    },
    required: ["target", "option"],
    additionalProperties: false,
  },
  describe: (a) => `Select "${str(a, "option") ?? "?"}" in ${str(a, "target") ?? "?"}`,
  async execute(args, ctx) {
    const page = ctx.session.page;
    const target = requireStr(args, "target");
    const option = requireStr(args, "option");
    const resolved = await resolve(page, target);
    if (!resolved) return notFound(ctx, target);
    try {
      let chosen = await resolved.locator.selectOption({ label: option }, { timeout: 3_000 }).catch(() => undefined);
      let recovered = false;
      if (!chosen) {
        chosen = await resolved.locator.selectOption({ value: option }, { timeout: 3_000 });
        recovered = true;
      }
      await settle(page, 800);
      return ok(`Selected ${JSON.stringify(chosen)} in "${target}". ${pageState(page)}`, { recovered });
    } catch (err) {
      const options = await resolved.locator
        .locator("option")
        .allTextContents()
        .catch(() => [] as string[]);
      return fail(
        `Could not select "${option}" in "${target}": ${truncate(err instanceof Error ? err.message : String(err), 200)}.${
          options.length ? ` Available options: ${options.map((o) => o.trim()).join(" | ")}` : " Not a native <select>? Use click instead."
        }`,
      );
    }
  },
};

export const scroll: ToolDefinition = {
  name: "scroll",
  description: "Scroll the page (or a scrollable element) by direction, or scroll a target element into view.",
  inputSchema: {
    type: "object",
    properties: {
      direction: { type: "string", enum: ["down", "up", "bottom", "top"] },
      pixels: { type: "integer", description: "Amount for up/down. Default 600." },
      target: { type: "string", description: "Scroll this element into view instead." },
    },
    additionalProperties: false,
  },
  describe: (a) => (str(a, "target") ? `Scroll to ${str(a, "target")}` : `Scroll ${str(a, "direction") ?? "down"}`),
  async execute(args, ctx) {
    const page = ctx.session.page;
    const target = str(args, "target");
    if (target) {
      const resolved = await resolve(page, target);
      if (!resolved) return notFound(ctx, target);
      await resolved.locator.scrollIntoViewIfNeeded({ timeout: 3_000 });
      return ok(`Scrolled "${target}" into view.`);
    }
    const dir = str(args, "direction") ?? "down";
    const px = num(args, "pixels", 600);
    await page.evaluate(SCROLL_SOURCE, { dir, px });
    await page.waitForTimeout(300);
    const pos = await page.evaluate(SCROLL_POSITION_SOURCE);
    const snap = await snapshotDom(page, { maxElements: 40, maxText: 400 }).catch(() => undefined);
    return ok(`Scrolled ${dir}. Position ${pos.y}/${Math.max(pos.max, 0)}.${snap ? `\n${formatSnapshot(snap)}` : ""}`);
  },
};

export const waitFor: ToolDefinition = {
  name: "wait_for",
  description: "Wait for an element, text, or URL pattern to appear (or just pause). Use sparingly: click/navigate already wait for the page to settle.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Element to wait for." },
      text: { type: "string", description: "Text to wait for anywhere on the page." },
      url: { type: "string", description: "Substring the URL should contain." },
      timeoutMs: { type: "integer", description: "Default 5000, max 20000." },
    },
    additionalProperties: false,
  },
  describe: (a) => `Wait for ${str(a, "target") ?? str(a, "text") ?? str(a, "url") ?? `${num(a, "timeoutMs", 5000)}ms`}`,
  async execute(args, ctx) {
    const page = ctx.session.page;
    const timeout = Math.min(num(args, "timeoutMs", 5_000), 20_000);
    const target = str(args, "target");
    const text = str(args, "text");
    const url = str(args, "url");
    try {
      if (target) {
        const resolved = await resolve(page, target, { waitMs: timeout });
        if (!resolved) return fail(`"${target}" did not appear within ${timeout}ms. ${pageState(page)}`);
        return ok(`"${target}" is present (${resolved.strategy}).`);
      }
      if (text) {
        await page.getByText(text).first().waitFor({ state: "visible", timeout });
        return ok(`Text "${text}" is visible.`);
      }
      if (url) {
        await page.waitForURL((u) => u.href.includes(url), { timeout });
        return ok(`URL now contains "${url}": ${page.url()}`);
      }
      await page.waitForTimeout(Math.min(timeout, 5_000));
      return ok(`Waited ${Math.min(timeout, 5_000)}ms. ${pageState(page)}`);
    } catch (err) {
      return fail(`Timed out after ${timeout}ms waiting for ${target ?? text ?? url}. ${pageState(page)}`);
    }
  },
};

export const goBack: ToolDefinition = {
  name: "go_back",
  description: "Browser back.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  describe: () => "Go back",
  async execute(_args, ctx) {
    const page = ctx.session.page;
    const res = await page.goBack({ waitUntil: "domcontentloaded", timeout: 10_000 }).catch(() => null);
    await settle(page);
    if (!res && page.url() === "about:blank") return fail("Nothing to go back to.");
    const snap = await snapshotDom(page, { maxElements: 40, maxText: 400 }).catch(() => undefined);
    return ok(`Went back. ${pageState(page)}${snap ? `\n${formatSnapshot(snap)}` : ""}`);
  },
};

export const screenshot: ToolDefinition = {
  name: "screenshot",
  description: "Capture the viewport. The image is returned to you and attached as evidence to the next finding you file.",
  inputSchema: {
    type: "object",
    properties: { label: { type: "string", description: "Short caption for the evidence record." } },
    additionalProperties: false,
  },
  describe: (a) => `Screenshot${str(a, "label") ? `: ${str(a, "label")}` : ""}`,
  async execute(args, ctx) {
    try {
      const shot = await ctx.session.screenshot(str(args, "label"));
      ctx.state.lastScreenshotId = shot.id;
      return ok(`Captured ${shot.id} of ${shot.pageUrl}.`, { screenshot: shot });
    } catch (err) {
      return fail(`Screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const readDom: ToolDefinition = {
  name: "read_dom",
  description:
    "Snapshot the current page: URL, title, headings, every visible interactive element with a ref you can pass to click/type, and a text excerpt. Call this whenever you are unsure what is on screen.",
  inputSchema: {
    type: "object",
    properties: {
      within: { type: "string", description: "CSS selector to scope the snapshot, e.g. \"form\" or \"#cart\"." },
      maxElements: { type: "integer", description: "Default 80." },
    },
    additionalProperties: false,
  },
  describe: (a) => `Read DOM${str(a, "within") ? ` within ${str(a, "within")}` : ""}`,
  async execute(args, ctx) {
    try {
      const snap = await snapshotDom(ctx.session.page, {
        within: str(args, "within"),
        maxElements: Math.min(num(args, "maxElements", 80), 200),
      });
      return ok(formatSnapshot(snap));
    } catch (err) {
      return fail(`Could not read the page: ${err instanceof Error ? err.message : String(err)}. The page may be mid-navigation; try wait_for or navigate.`);
    }
  },
};

export const readText: ToolDefinition = {
  name: "read_text",
  description: "Read the visible text of the page or of one element. Use to verify totals, error messages, and copy.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", description: "Element to read. Omit for the whole page." },
      maxChars: { type: "integer", description: "Default 4000." },
    },
    additionalProperties: false,
  },
  describe: (a) => `Read text${str(a, "target") ? ` of ${str(a, "target")}` : ""}`,
  async execute(args, ctx) {
    const page = ctx.session.page;
    const max = Math.min(num(args, "maxChars", 4_000), 20_000);
    const target = str(args, "target");
    try {
      if (target) {
        const resolved = await resolve(page, target);
        if (!resolved) return notFound(ctx, target);
        const text = await resolved.locator.innerText({ timeout: 3_000 });
        return ok(truncate(text.trim(), max));
      }
      const text = await page.evaluate(BODY_TEXT_SOURCE);
      return ok(truncate(text.replace(/\n{3,}/g, "\n\n").trim(), max) || "(page has no visible text)");
    } catch (err) {
      return fail(`Could not read text: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const callApi: ToolDefinition = {
  name: "call_api",
  description:
    "Send an HTTP request with the browser's cookies (same session as the UI). Use to probe endpoints behind a surface, check what the UI submitted, or reproduce a failure without the UI. Returns status and a body excerpt.",
  inputSchema: {
    type: "object",
    properties: {
      method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
      url: { type: "string", description: "Absolute URL or path." },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string", description: "Raw body; set Content-Type in headers (defaults to application/json when body looks like JSON)." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  describe: (a) => `${str(a, "method") ?? "GET"} ${str(a, "url") ?? "?"}`,
  async execute(args, ctx) {
    const { session } = ctx;
    const method = (str(args, "method") ?? "GET").toUpperCase();
    const url = session.resolveUrl(requireStr(args, "url"));
    if (session.isOutOfBounds(url)) return fail(`Refused: ${url} is inside a blast-radius boundary.`);
    const headers = (args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : {}) ?? {};
    const body = str(args, "body");
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type") && /^\s*[[{]/.test(body)) {
      headers["Content-Type"] = "application/json";
    }
    try {
      const res = await session.page.request.fetch(url, {
        method,
        headers,
        data: body,
        timeout: 15_000,
        maxRedirects: 5,
        failOnStatusCode: false,
      });
      const text = await res.text().catch(() => "");
      const ct = res.headers()["content-type"] ?? "";
      return ok(`${method} ${url} -> HTTP ${res.status()} ${res.statusText()} (${ct || "no content-type"})\n${truncate(text, 3_000)}`);
    } catch (err) {
      return fail(`${method} ${url} failed: ${truncate(err instanceof Error ? err.message : String(err), 300)}`);
    }
  },
};

export const PRIMITIVE_TOOLS: ToolDefinition[] = [
  navigate,
  click,
  type,
  pressKey,
  selectOption,
  scroll,
  waitFor,
  goBack,
  screenshot,
  readDom,
  readText,
  callApi,
];
