/**
 * Creates the GitHub App with the exact permissions and events the control
 * plane needs, using GitHub's App Manifest flow, and writes the credentials
 * into packages/control-plane/.env.
 *
 *   pnpm --filter @qa-agent/control-plane create-app [--org <org>] [--force]
 *
 * 1. Creates a smee.io channel for local webhook delivery (unless SMEE_URL is set).
 * 2. Opens a local page that posts the manifest to GitHub.
 * 3. GitHub redirects back with a code; we exchange it for the App id, slug,
 *    private key, and webhook secret.
 * 4. The private key is written outside the repo (~/.config/qa-agent/<slug>.pem).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { Octokit } from "octokit";
import SmeeClient from "smee-client";
import { deriveWebBaseUrl } from "../src/config";

const CALLBACK_PORT = 3456;
const here = dirname(fileURLToPath(import.meta.url));
const envPath = join(here, "..", ".env");
const envExamplePath = join(here, "..", ".env.example");

const args = process.argv.slice(2);
const force = args.includes("--force");
const orgIndex = args.indexOf("--org");
const org = orgIndex >= 0 ? args[orgIndex + 1] : undefined;

const existing = existsSync(envPath) ? parse(readFileSync(envPath)) : {};
if (existing.GITHUB_APP_ID && !force) {
  console.error(`GITHUB_APP_ID is already set in ${envPath}. Re-run with --force to create another App.`);
  process.exit(1);
}

const apiBaseUrl = (existing.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/$/, "");
const webBaseUrl = deriveWebBaseUrl(apiBaseUrl);
const port = Number(existing.PORT || 3001);
const publicUrl = (existing.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, "");

async function main() {
  const smeeUrl = existing.SMEE_URL || (await SmeeClient.createChannel());
  const state = randomBytes(16).toString("hex");

  const manifest = {
    name: `Agentic QA Fleet ${randomBytes(2).toString("hex")}`,
    url: "https://github.com/joshmkim/qa-agent",
    description: "Fleet-driven QA gate for pre-production pipelines.",
    public: false,
    hook_attributes: { url: smeeUrl, active: true },
    redirect_url: `http://localhost:${CALLBACK_PORT}/callback`,
    setup_url: `${publicUrl}/github/setup`,
    setup_on_update: true,
    default_permissions: {
      contents: "read",
      pull_requests: "read",
      metadata: "read",
      checks: "write",
    },
    // Installation events are delivered to every App without subscribing.
    default_events: ["push", "check_run"],
  };

  const createUrl = org
    ? `${webBaseUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}`
    : `${webBaseUrl}/settings/apps/new?state=${state}`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!doctype html><title>Create GitHub App</title>
<p>Redirecting to GitHub to create the App…</p>
<form id="f" method="post" action="${createUrl}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <noscript><button>Continue to GitHub</button></noscript>
</form>
<script>document.getElementById("f").submit()</script>`);
      return;
    }

    if (url.pathname === "/callback") {
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) {
        res.writeHead(400).end("Missing code or state mismatch.");
        return;
      }
      try {
        const octokit = new Octokit({ baseUrl: apiBaseUrl });
        const { data: app } = await octokit.rest.apps.createFromManifest({ code });
        const pemPath = writePrivateKey(app.slug ?? String(app.id), app.pem);
        writeEnv({
          GITHUB_APP_ID: String(app.id),
          GITHUB_APP_SLUG: app.slug ?? "",
          GITHUB_PRIVATE_KEY: "",
          GITHUB_PRIVATE_KEY_PATH: pemPath,
          GITHUB_WEBHOOK_SECRET: app.webhook_secret ?? "",
          SMEE_URL: smeeUrl,
        });
        const installUrl = `${app.html_url}/installations/new`;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<!doctype html><title>App created</title>
<p>Created <b>${app.name}</b>. Credentials were written to <code>packages/control-plane/.env</code>.</p>
<p><a href="${installUrl}">Install it on your repository</a> (choose "Only select repositories").</p>`);

        console.log(`\nCreated GitHub App "${app.name}" (id ${app.id}, slug ${app.slug}).`);
        console.log(`  private key: ${pemPath}`);
        console.log(`  webhooks:    ${smeeUrl}`);
        console.log(`  .env:        ${envPath}`);
        console.log(`\nNext: install it on your repo -> ${installUrl}`);
        console.log("Then run `pnpm --filter @qa-agent/control-plane dev` and `... tunnel`.");
      } catch (err) {
        console.error("Manifest conversion failed:", err);
        res.writeHead(500).end(`Manifest conversion failed: ${(err as Error).message}`);
      } finally {
        server.close();
      }
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(CALLBACK_PORT, () => {
    const start = `http://localhost:${CALLBACK_PORT}/`;
    console.log(`Creating a GitHub App ${org ? `under org ${org}` : "under your personal account"}.`);
    console.log(`Webhook relay: ${smeeUrl}`);
    console.log(`Opening ${start} (open it manually if nothing happens).`);
    openBrowser(start);
  });
}

function writePrivateKey(slug: string, pem: string): string {
  const dir = join(homedir(), ".config", "qa-agent");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${slug}.pem`);
  writeFileSync(path, pem, { mode: 0o600 });
  return path;
}

/** Sets keys in .env (seeded from .env.example), keeping comments and every other line. */
function writeEnv(values: Record<string, string>): void {
  const source = existsSync(envPath) ? envPath : envExamplePath;
  const lines = readFileSync(source, "utf8").split("\n");
  const remaining = new Map(Object.entries(values));
  const out = lines.map((line) => {
    const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key) as string;
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) out.push(`${key}=${value}`);
  writeFileSync(envPath, out.join("\n"), { mode: 0o600 });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).on("error", () => {});
}

void main();
