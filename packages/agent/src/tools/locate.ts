import type { Locator, Page } from "playwright";

/**
 * Turning what the model says ("Add to cart", "e12", "#checkout") into an
 * element is where agents stall most. This resolver tries, in order:
 *
 *   1. a ref from the last read_dom snapshot ("e12" -> [data-qa-ref="e12"])
 *   2. an explicit Playwright-style prefix (css=, text=, role=, testid=, label=,
 *      placeholder=, xpath=)
 *   3. something that looks like a CSS selector
 *   4. natural language: role+name, exact text, label, placeholder, test id,
 *      then substring text
 *
 * and prefers visible matches. Returns the strategy used so the trace shows
 * how the element was found.
 */

export interface Resolved {
  locator: Locator;
  strategy: string;
  matches: number;
  ambiguous: boolean;
}

export const REF_ATTR = "data-qa-ref";
const REF_RE = /^e\d+$/;
const CSS_HINT_RE = /^[#.[]|[>~+]|^[a-z]+[#.[:]|^\*|\[.+=.+\]/i;
const INTERACTIVE_ROLES = ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "tab", "option", "switch"] as const;

function candidates(page: Page, target: string): Array<{ strategy: string; locator: Locator }> {
  const t = target.trim();
  const out: Array<{ strategy: string; locator: Locator }> = [];

  if (REF_RE.test(t)) {
    out.push({ strategy: `ref ${t}`, locator: page.locator(`[${REF_ATTR}="${t}"]`) });
    return out;
  }

  const prefixed = /^(css|text|role|testid|label|placeholder|xpath)=(.+)$/s.exec(t);
  if (prefixed) {
    const [, kind, value] = prefixed as unknown as [string, string, string];
    switch (kind) {
      case "css":
        out.push({ strategy: "css", locator: page.locator(value) });
        break;
      case "xpath":
        out.push({ strategy: "xpath", locator: page.locator(`xpath=${value}`) });
        break;
      case "text":
        out.push({ strategy: "text", locator: page.getByText(value, { exact: true }) });
        out.push({ strategy: "text~", locator: page.getByText(value) });
        break;
      case "testid":
        out.push({ strategy: "testid", locator: page.getByTestId(value) });
        break;
      case "label":
        out.push({ strategy: "label", locator: page.getByLabel(value) });
        break;
      case "placeholder":
        out.push({ strategy: "placeholder", locator: page.getByPlaceholder(value) });
        break;
      case "role": {
        // role=button[name=Add to cart] or role=button
        const m = /^([a-z]+)(?:\[name=(.+)\])?$/i.exec(value);
        if (m) {
          const role = m[1] as Parameters<Page["getByRole"]>[0];
          out.push({ strategy: "role", locator: page.getByRole(role, m[2] ? { name: m[2] } : undefined) });
        }
        break;
      }
    }
    return out;
  }

  if (CSS_HINT_RE.test(t)) {
    out.push({ strategy: "css", locator: page.locator(t) });
  }

  // Natural language fallbacks. Exact matches first so "Cart" doesn't grab
  // "Add to cart".
  for (const role of INTERACTIVE_ROLES) {
    out.push({ strategy: `role:${role}`, locator: page.getByRole(role, { name: t, exact: true }) });
  }
  out.push({ strategy: "testid", locator: page.getByTestId(t) });
  out.push({ strategy: "label", locator: page.getByLabel(t, { exact: true }) });
  out.push({ strategy: "placeholder", locator: page.getByPlaceholder(t, { exact: true }) });
  out.push({ strategy: "text", locator: page.getByText(t, { exact: true }) });
  for (const role of INTERACTIVE_ROLES) {
    out.push({ strategy: `role~:${role}`, locator: page.getByRole(role, { name: t }) });
  }
  out.push({ strategy: "label~", locator: page.getByLabel(t) });
  out.push({ strategy: "placeholder~", locator: page.getByPlaceholder(t) });
  out.push({ strategy: "text~", locator: page.getByText(t) });
  out.push({ strategy: "title", locator: page.locator(`[title="${cssEscape(t)}"], [aria-label="${cssEscape(t)}"]`) });
  out.push({ strategy: "name", locator: page.locator(`[name="${cssEscape(t)}"], [id="${cssEscape(t)}"]`) });
  return out;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

export interface ResolveOptions {
  /** Pick the nth match (0-based) when several elements match. */
  nth?: number;
  /** Wait this long for a first match before giving up (dynamic content). */
  waitMs?: number;
}

export async function resolve(page: Page, target: string, opts: ResolveOptions = {}): Promise<Resolved | undefined> {
  const deadline = Date.now() + (opts.waitMs ?? 2_000);
  // First pass immediately, then poll until the deadline: SPAs render late.
  for (;;) {
    const found = await tryResolve(page, target, opts.nth);
    if (found || Date.now() >= deadline) return found;
    await page.waitForTimeout(250);
  }
}

async function tryResolve(page: Page, target: string, nth?: number): Promise<Resolved | undefined> {
  let firstHidden: Resolved | undefined;
  for (const c of candidates(page, target)) {
    let count: number;
    try {
      count = await c.locator.count();
    } catch {
      continue; // invalid selector for this strategy
    }
    if (count === 0) continue;

    if (nth !== undefined) {
      if (nth >= count) continue;
      return { locator: c.locator.nth(nth), strategy: c.strategy, matches: count, ambiguous: false };
    }

    // Prefer the first visible match.
    for (let i = 0; i < Math.min(count, 10); i++) {
      const el = c.locator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        return { locator: el, strategy: c.strategy, matches: count, ambiguous: count > 1 };
      }
    }
    firstHidden ??= { locator: c.locator.first(), strategy: `${c.strategy} (hidden)`, matches: count, ambiguous: count > 1 };
  }
  return firstHidden;
}
