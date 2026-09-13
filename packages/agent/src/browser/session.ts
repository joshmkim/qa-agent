import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";

export interface ConsoleError {
  kind: "console" | "pageerror" | "crash";
  text: string;
  pageUrl: string;
  at: string; // ISO-8601
}

export interface NetworkFailure {
  method: string;
  url: string;
  /** HTTP status for 4xx/5xx responses; undefined when the request never completed. */
  status?: number;
  /** Playwright failure text (net::ERR_*, aborted) when the request never completed. */
  failureText?: string;
  pageUrl: string;
  at: string;
}

export interface Screenshot {
  id: string;
  /** Absolute path of the PNG on disk. */
  path: string;
  base64: string;
  pageUrl: string;
  capturedAt: string;
}

export interface BrowserSessionOptions {
  baseUrl: string;
  headless?: boolean;
  /** Hosts, path prefixes, or URL substrings the agent must never reach. */
  blastRadiusBoundaries?: string[];
  /** Where screenshots are written. Defaults to a per-session tmp dir. */
  screenshotDir?: string;
  viewport?: { width: number; height: number };
  /** Max entries kept per error buffer. */
  bufferSize?: number;
  /** Extra HTTP headers on every request, e.g. a preprod bypass token. */
  extraHTTPHeaders?: Record<string, string>;
  userAgent?: string;
  /** Record a .webm of the session next to the screenshots. Off by default. */
  recordVideo?: boolean;
}

/** Statuses that count as a hard error regardless of what the UI shows. */
export function isServerError(status: number): boolean {
  return status >= 500;
}

/**
 * One agent's browser. Wraps a Playwright context and records everything the
 * page emits that a human tester would never see: console errors, uncaught
 * exceptions, failed or 5xx requests. Tools read those buffers so hard
 * errors are caught even when the agent didn't think to look.
 */
export class BrowserSession {
  private browser!: Browser;
  private context!: BrowserContext;
  page!: Page;

  readonly baseUrl: URL;
  readonly screenshotDir: string;
  private readonly boundaries: string[];
  private readonly bufferSize: number;

  private consoleErrors: ConsoleError[] = [];
  private networkFailures: NetworkFailure[] = [];
  private screenshots = new Map<string, Screenshot>();
  private screenshotSeq = 0;
  /** How many hard errors have been handed out by drainHardErrors(). */
  private drained = { console: 0, network: 0 };
  private blockedNavigations: string[] = [];

  private constructor(private readonly opts: BrowserSessionOptions) {
    this.baseUrl = new URL(opts.baseUrl);
    this.boundaries = (opts.blastRadiusBoundaries ?? []).map((b) => b.trim()).filter(Boolean);
    this.bufferSize = opts.bufferSize ?? 200;
    this.screenshotDir =
      opts.screenshotDir ?? path.join(tmpdir(), "qa-agent", `session-${Date.now()}-${process.pid}`);
  }

  static async launch(opts: BrowserSessionOptions): Promise<BrowserSession> {
    const session = new BrowserSession(opts);
    await session.start();
    return session;
  }

  private async start(): Promise<void> {
    await mkdir(this.screenshotDir, { recursive: true });
    const viewport = this.opts.viewport ?? { width: 1280, height: 900 };
    this.browser = await chromium.launch({ headless: this.opts.headless ?? true });
    this.context = await this.browser.newContext({
      viewport,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: this.opts.extraHTTPHeaders,
      userAgent: this.opts.userAgent,
      ...(this.opts.recordVideo ? { recordVideo: { dir: this.screenshotDir, size: viewport } } : {}),
    });
    this.context.setDefaultTimeout(10_000);
    this.context.setDefaultNavigationTimeout(30_000);

    // Blast radius: refuse to load anything inside a boundary. Only the
    // request is aborted; the page keeps working so the agent can continue.
    if (this.boundaries.length) {
      await this.context.route("**/*", (route) => {
        const url = route.request().url();
        if (this.isOutOfBounds(url)) {
          this.blockedNavigations.push(url);
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
    }

    this.page = await this.context.newPage();
    this.attachListeners(this.page);
    // Popups get the same instrumentation and are folded back into `page`
    // so the agent never loses track of where it is.
    this.context.on("page", (p) => {
      this.attachListeners(p);
      this.page = p;
    });
  }

  private attachListeners(page: Page): void {
    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      this.pushConsole({ kind: "console", text: msg.text(), pageUrl: page.url(), at: now() });
    });
    page.on("pageerror", (err) => {
      this.pushConsole({ kind: "pageerror", text: `${err.name}: ${err.message}`, pageUrl: page.url(), at: now() });
    });
    page.on("crash", () => {
      this.pushConsole({ kind: "crash", text: "Page crashed", pageUrl: page.url(), at: now() });
    });
    page.on("requestfailed", (req: Request) => {
      const failure = req.failure()?.errorText ?? "unknown";
      // Our own blast-radius aborts, and the browser cancelling its own
      // requests (navigation away mid-load, prefetch, preflight), are not app
      // failures. Real network errors (refused, DNS, timeout, reset) still count.
      if (failure.includes("BLOCKED_BY_CLIENT") || failure.includes("ERR_ABORTED")) return;
      this.pushNetwork({ method: req.method(), url: req.url(), failureText: failure, pageUrl: page.url(), at: now() });
    });
    page.on("response", (res) => {
      const status = res.status();
      if (status < 400) return;
      const req = res.request();
      this.pushNetwork({ method: req.method(), url: res.url(), status, pageUrl: page.url(), at: now() });
    });
    page.on("close", () => {
      if (this.page === page) {
        const remaining = this.context.pages();
        const last = remaining[remaining.length - 1];
        if (last) this.page = last;
      }
    });
  }

  private pushConsole(e: ConsoleError): void {
    this.consoleErrors.push(e);
    if (this.consoleErrors.length > this.bufferSize) {
      this.consoleErrors.shift();
      this.drained.console = Math.max(0, this.drained.console - 1);
    }
  }

  private pushNetwork(e: NetworkFailure): void {
    this.networkFailures.push(e);
    if (this.networkFailures.length > this.bufferSize) {
      this.networkFailures.shift();
      this.drained.network = Math.max(0, this.drained.network - 1);
    }
  }

  /**
   * True when a URL touches a blast-radius boundary. Boundaries are matched
   * as: full host ("admin.example.com"), path prefix ("/admin"), or a plain
   * substring of the absolute URL.
   */
  isOutOfBounds(rawUrl: string): boolean {
    let url: URL;
    try {
      url = new URL(rawUrl, this.baseUrl);
    } catch {
      return true;
    }
    for (const b of this.boundaries) {
      if (b.startsWith("/")) {
        if (url.pathname === b || url.pathname.startsWith(b.endsWith("/") ? b : `${b}/`)) return true;
      } else if (b.includes("://")) {
        if (url.href.startsWith(b)) return true;
      } else if (url.hostname === b || url.hostname.endsWith(`.${b}`)) {
        return true;
      } else if (url.href.includes(b)) {
        return true;
      }
    }
    return false;
  }

  /** Resolve a possibly-relative URL against the environment base. */
  resolveUrl(target: string): string {
    return new URL(target, this.page.url() && this.page.url() !== "about:blank" ? this.page.url() : this.baseUrl).href;
  }

  async screenshot(label = "screenshot"): Promise<Screenshot> {
    const id = `shot_${String(++this.screenshotSeq).padStart(3, "0")}`;
    const file = path.join(this.screenshotDir, `${id}.png`);
    const buffer = await this.page.screenshot({ type: "png", fullPage: false, timeout: 5_000 }).catch(() => undefined);
    if (!buffer) throw new Error(`Screenshot failed (${label})`);
    await writeFile(file, buffer);
    const shot: Screenshot = {
      id,
      path: file,
      base64: buffer.toString("base64"),
      pageUrl: this.page.url(),
      capturedAt: now(),
    };
    this.screenshots.set(id, shot);
    return shot;
  }

  getScreenshot(id: string): Screenshot | undefined {
    return this.screenshots.get(id);
  }

  /** Everything recorded so far. */
  allConsoleErrors(): ConsoleError[] {
    return [...this.consoleErrors];
  }

  allNetworkFailures(): NetworkFailure[] {
    return [...this.networkFailures];
  }

  /**
   * Hard errors not yet reported: uncaught exceptions, crashes, 5xx, and
   * requests that never completed. 4xx and console.error noise are left for
   * the agent to inspect on demand via get_console_errors.
   */
  drainHardErrors(): { console: ConsoleError[]; network: NetworkFailure[] } {
    const console = this.consoleErrors.slice(this.drained.console).filter((e) => e.kind !== "console");
    const network = this.networkFailures
      .slice(this.drained.network)
      .filter((f) => (f.status !== undefined ? isServerError(f.status) : true));
    this.drained.console = this.consoleErrors.length;
    this.drained.network = this.networkFailures.length;
    return { console, network };
  }

  takeBlockedNavigations(): string[] {
    const out = this.blockedNavigations;
    this.blockedNavigations = [];
    return out;
  }

  /**
   * Close the browser. Returns the recording's path when `recordVideo` was
   * on: Playwright only finalizes the .webm once the context is closed. With
   * popups, the main (first) page's video is returned; the rest stay on disk.
   */
  async close(): Promise<{ videoPath?: string }> {
    const first = this.context.pages()[0];
    const video = this.opts.recordVideo ? first?.video() : undefined;
    // Ask for the path before closing (the promise resolves after close).
    const pathPromise = video?.path().catch(() => undefined);
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
    const videoPath = pathPromise ? await pathPromise : undefined;
    return videoPath ? { videoPath } : {};
  }
}

function now(): string {
  return new Date().toISOString();
}
