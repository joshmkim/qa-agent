import type { Page } from "playwright";
import { REF_ATTR } from "../tools/locate";

export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  /** Best stable selector hint: data-testid, id, or aria-label. */
  hint?: string;
  href?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface DomSnapshot {
  url: string;
  title: string;
  headings: string[];
  elements: SnapshotElement[];
  /** Visible text near the top of the page, for orientation. */
  textExcerpt: string;
  totalInteractive: number;
}

export interface SnapshotOptions {
  maxElements?: number;
  maxText?: number;
  /** Only include elements inside this CSS scope. */
  within?: string;
}

interface SnapshotArgs {
  maxElements: number;
  maxText: number;
  within?: string;
  refAttr: string;
}

/**
 * Browser-side snapshot code, kept as plain JS source on purpose: Playwright
 * serializes evaluate() callbacks with toString(), and Node-side transforms
 * (tsx/esbuild keepNames, coverage instrumentation) inject helpers like
 * `__name` that don't exist in the page. A string can't be rewritten.
 */
const SNAPSHOT_SOURCE = String.raw`
  var maxElements = args.maxElements, maxText = args.maxText, within = args.within, refAttr = args.refAttr;
  var root = (within && document.querySelector(within)) || document;
  var selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=checkbox]", "[role=radio]",
    "[role=switch]", "[role=combobox]", "[role=option]", "[contenteditable=true]", "[onclick]",
    "[tabindex]:not([tabindex='-1'])"
  ].join(",");

  function isVisible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function clean(s) { return (s || "").trim().replace(/\s+/g, " "); }

  function nameOf(el) {
    var aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    var labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      var t = labelledBy.split(/\s+/).map(function (id) {
        var n = document.getElementById(id); return n ? clean(n.textContent) : "";
      }).filter(Boolean).join(" ");
      if (t) return t;
    }
    var tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (el.id) {
        var label = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
        if (label && clean(label.textContent)) return clean(label.textContent);
      }
      var wrapping = el.closest("label");
      if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent);
      if (el.placeholder) return el.placeholder;
      if (el.name) return el.name;
    }
    if (tag === "input" && (el.type === "submit" || el.type === "button") && el.value) return el.value;
    var text = clean(el.innerText || el.textContent);
    if (text) return text;
    var img = el.querySelector("img[alt]");
    if (img) return clean(img.getAttribute("alt"));
    return clean(el.getAttribute("title"));
  }

  function roleOf(el) {
    var explicit = el.getAttribute("role");
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var type = el.type;
      if (type === "checkbox" || type === "radio") return type;
      if (type === "submit" || type === "button" || type === "reset") return "button";
      return "textbox";
    }
    if (el.getAttribute("contenteditable") === "true") return "textbox";
    return tag;
  }

  document.querySelectorAll("[" + refAttr + "]").forEach(function (el) { el.removeAttribute(refAttr); });

  var all = Array.prototype.filter.call(root.querySelectorAll(selector), isVisible);
  var elements = all.slice(0, maxElements).map(function (el, i) {
    var ref = "e" + (i + 1);
    el.setAttribute(refAttr, ref);
    var testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || el.getAttribute("data-test-id");
    var entry = { ref: ref, role: roleOf(el), name: nameOf(el).slice(0, 80) };
    if (testId) entry.hint = "testid=" + testId; else if (el.id) entry.hint = "#" + el.id;
    var tag = el.tagName.toLowerCase();
    if (tag === "a" && el.getAttribute("href")) entry.href = el.getAttribute("href").slice(0, 120);
    if (tag === "input") {
      if (el.type === "checkbox" || el.type === "radio") entry.checked = el.checked;
      else if (el.type !== "password" && el.value) entry.value = el.value.slice(0, 60);
    } else if ((tag === "select" || tag === "textarea") && el.value) {
      entry.value = el.value.slice(0, 60);
    }
    if (el.disabled || el.getAttribute("aria-disabled") === "true") entry.disabled = true;
    return entry;
  });

  var headings = Array.prototype.filter.call(document.querySelectorAll("h1,h2,h3"), isVisible).slice(0, 15)
    .map(function (h) { return h.tagName.toLowerCase() + ": " + clean(h.textContent).slice(0, 100); });

  var bodyText = (document.body ? document.body.innerText : "").replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();

  return {
    url: location.href,
    title: document.title,
    headings: headings,
    elements: elements,
    textExcerpt: bodyText.slice(0, maxText),
    totalInteractive: all.length
  };
`;

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const snapshotFn = new Function("args", SNAPSHOT_SOURCE) as (args: SnapshotArgs) => DomSnapshot;

/**
 * Compact, LLM-friendly view of the page: every interactive element with a
 * short ref the agent can click/type by, plus headings and a text excerpt.
 * Refs are written onto the DOM as data-qa-ref so they survive until the
 * next navigation; read_dom reassigns them.
 */
export async function snapshotDom(page: Page, opts: SnapshotOptions = {}): Promise<DomSnapshot> {
  const args: SnapshotArgs = {
    maxElements: opts.maxElements ?? 80,
    maxText: opts.maxText ?? 1500,
    within: opts.within,
    refAttr: REF_ATTR,
  };
  return page.evaluate(snapshotFn, args);
}

/** Render a snapshot as the compact text the model reads. */
export function formatSnapshot(s: DomSnapshot): string {
  const lines: string[] = [`URL: ${s.url}`, `Title: ${s.title}`];
  if (s.headings.length) lines.push(`Headings: ${s.headings.join(" | ")}`);
  lines.push(`Interactive elements (${s.elements.length}${s.totalInteractive > s.elements.length ? ` of ${s.totalInteractive}; pass within= to scope` : ""}):`);
  for (const e of s.elements) {
    const parts = [`[${e.ref}] ${e.role}`, e.name ? `"${e.name}"` : ""];
    if (e.hint) parts.push(e.hint);
    if (e.href) parts.push(`-> ${e.href}`);
    if (e.value !== undefined) parts.push(`value="${e.value}"`);
    if (e.checked !== undefined) parts.push(e.checked ? "checked" : "unchecked");
    if (e.disabled) parts.push("DISABLED");
    lines.push("  " + parts.filter(Boolean).join(" "));
  }
  if (s.textExcerpt) lines.push(`Visible text:\n${s.textExcerpt}`);
  return lines.join("\n");
}
