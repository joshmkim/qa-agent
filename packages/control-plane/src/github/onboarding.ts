import { Hono } from "hono";
import type { GitHubConfig } from "../config";
import type { Store } from "../store";
import { installUrl, type GitHubApp } from "./app";

export interface OnboardingDeps {
  github: GitHubApp;
  store: Store;
  config: GitHubConfig;
}

/**
 * How an external repo gets connected: the user is sent to GitHub's install
 * page for our App, picks an org and repos, and GitHub redirects back here.
 * The `installation.created` webhook is the source of truth for what was
 * granted; these routes only start the flow and let the user confirm it.
 *
 * No auth on the read routes yet; see the note in api.ts.
 */
export function githubOnboarding(deps: OnboardingDeps): Hono {
  const { github, store, config } = deps;
  const app = new Hono();

  /** Redirect to GitHub's install page. Optional ?state= is echoed back to /setup. */
  app.get("/install", (c) => {
    try {
      return c.redirect(installUrl(config, c.req.query("state")));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  /**
   * Configure this as the App's "Setup URL". GitHub redirects here with
   * ?installation_id=&setup_action=install|update. If the webhook hasn't
   * landed yet, fetch the installation directly so the user sees it.
   */
  app.get("/setup", async (c) => {
    const raw = c.req.query("installation_id");
    const installationId = Number(raw);
    if (!raw || Number.isNaN(installationId)) {
      return c.json({ error: "bad-request", message: "installation_id is required" }, 400);
    }
    let installation = await store.getInstallation(installationId);
    if (!installation) {
      const { data } = await github.octokit.rest.apps.getInstallation({ installation_id: installationId });
      installation = {
        installationId: data.id,
        accountLogin: accountLogin(data.account),
        accountType: accountType(data.account),
        repositorySelection: data.repository_selection,
        suspended: data.suspended_at != null,
        installedAt: data.created_at,
      };
      await store.upsertInstallation(installation);
    }
    return c.json({
      installation,
      repositories: await store.listRepositories(installationId),
      setupAction: c.req.query("setup_action"),
      state: c.req.query("state"),
    });
  });

  app.get("/installations", async (c) => c.json(await store.listInstallations()));

  app.get("/installations/:id/repositories", async (c) =>
    c.json(await store.listRepositories(Number(c.req.param("id")))),
  );

  /**
   * Reconcile the store with GitHub's view of what this installation can
   * access. Needed for "all repositories" installs (no per-repo webhook) and
   * after a restart of the in-memory store.
   */
  app.post("/installations/:id/sync", async (c) => {
    const installationId = Number(c.req.param("id"));
    const octokit = await github.getInstallationOctokit(installationId);
    const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    for (const r of repos) {
      await store.upsertRepository({
        id: String(r.id),
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        installationId,
        url: r.html_url,
      });
    }
    return c.json({ synced: repos.length });
  });

  return app;
}

function accountLogin(account: unknown): string {
  if (account && typeof account === "object") {
    if ("login" in account && typeof account.login === "string") return account.login;
    if ("slug" in account && typeof account.slug === "string") return account.slug;
  }
  return "unknown";
}

function accountType(account: unknown): "Organization" | "User" {
  return account && typeof account === "object" && "type" in account && account.type === "User"
    ? "User"
    : "Organization";
}
