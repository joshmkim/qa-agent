import { App } from "@octokit/app";
import { Octokit } from "octokit";
import type { GitHubConfig } from "../config";

/**
 * The GitHub App is the single auth root for every tenant. Each org/user that
 * installs the app produces an installation_id; from that id we mint
 * short-lived installation tokens scoped to exactly the repos they granted.
 *
 * `App` handles the App JWT (RS256, 10 min) -> installation token (1 hr)
 * exchange and caches tokens per installation, so callers just ask for an
 * installation Octokit and use it.
 *
 * We use `@octokit/app` directly (rather than the `octokit` meta-package's
 * re-export) so the generic resolves to the full-featured Octokit with
 * `.rest` and `.paginate`; the re-export's type collapses to core Octokit.
 */
type OctokitClass = typeof Octokit;

export type GitHubApp = App<{ Octokit: OctokitClass }>;
export type InstallationOctokit = InstanceType<OctokitClass>;

export function createGitHubApp(cfg: GitHubConfig): GitHubApp {
  const ConfiguredOctokit = Octokit.defaults({
    baseUrl: cfg.apiBaseUrl,
    userAgent: "agentic-qa-fleet/0.0.1",
  }) as OctokitClass;

  return new App({
    appId: cfg.appId,
    privateKey: cfg.privateKey,
    webhooks: { secret: cfg.webhookSecret },
    Octokit: ConfiguredOctokit,
  });
}

/** Where a user goes to grant us access to their repos. */
export function installUrl(cfg: GitHubConfig, state?: string): string {
  if (!cfg.appSlug) {
    throw new Error("GITHUB_APP_SLUG is required to build an install URL");
  }
  const url = new URL(`${cfg.webBaseUrl}/apps/${cfg.appSlug}/installations/new`);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}
