import { readFileSync } from "node:fs";
import type { Severity } from "@qa-agent/shared-types";

export interface GitHubConfig {
  appId: string;
  appSlug?: string;
  privateKey: string;
  webhookSecret: string;
  /** REST API base. https://api.github.com or https://ghes.example.com/api/v3 */
  apiBaseUrl: string;
  /** Web UI base derived from apiBaseUrl; used for install links. */
  webBaseUrl: string;
}

export interface SlackConfig {
  /** Bot user OAuth token (xoxb-...). */
  botToken: string;
  /** Channel that receives run reports. */
  channelId: string;
}

export interface JiraConfig {
  /** Site base URL, e.g. https://your-team.atlassian.net */
  baseUrl: string;
  /** Atlassian account email; used with the API token as HTTP Basic auth. */
  email: string;
  apiToken: string;
  /** Project that findings are filed into, e.g. "QA". */
  projectKey: string;
  /** Issue type name on that project's create screen. */
  issueType: string;
  /**
   * Project prefixes recognised when scanning PRs and commits for issue keys.
   * Defaults to [projectKey]; widen it when code references other projects.
   */
  projectKeys: string[];
  /** Least severe finding that gets filed. P3 files everything. */
  minSeverity: Severity;
}

export interface Config {
  port: number;
  publicUrl: string;
  /** Web UI base for run links. Falls back to publicUrl. */
  webUrl: string;
  github: GitHubConfig;
  /** Undefined when SLACK_BOT_TOKEN is unset; the bot is then disabled. */
  slack?: SlackConfig;
  /** Undefined when JIRA_BASE_URL is unset; issue filing is then disabled. */
  jira?: JiraConfig;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

function loadPrivateKey(): string {
  const inline = process.env.GITHUB_PRIVATE_KEY;
  const path = process.env.GITHUB_PRIVATE_KEY_PATH;
  if (inline && inline.trim() !== "") {
    // Allow the PEM to be pasted on one line with escaped newlines.
    return inline.replace(/\\n/g, "\n");
  }
  if (path && path.trim() !== "") {
    return readFileSync(path, "utf8");
  }
  throw new Error(
    "Set GITHUB_PRIVATE_KEY (PEM, \\n-escaped) or GITHUB_PRIVATE_KEY_PATH",
  );
}

/** Slack is optional: enabled only when a bot token is present. */
function loadSlack(env: NodeJS.ProcessEnv): SlackConfig | undefined {
  const botToken = env.SLACK_BOT_TOKEN;
  if (!botToken || botToken.trim() === "") return undefined;
  return {
    botToken,
    channelId: required("SLACK_CHANNEL_ID"),
  };
}

const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2", "P3"];

/** Jira is optional: enabled only when a site URL is present. */
function loadJira(env: NodeJS.ProcessEnv): JiraConfig | undefined {
  const baseUrl = env.JIRA_BASE_URL;
  if (!baseUrl || baseUrl.trim() === "") return undefined;

  const projectKey = required("JIRA_PROJECT_KEY").toUpperCase();
  const extraKeys = (env.JIRA_PROJECT_KEYS ?? "")
    .split(",")
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);
  const minSeverity = (env.JIRA_MIN_SEVERITY ?? "P1").toUpperCase() as Severity;
  if (!SEVERITIES.includes(minSeverity)) {
    throw new Error(`JIRA_MIN_SEVERITY must be one of ${SEVERITIES.join(", ")}`);
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    email: required("JIRA_EMAIL"),
    apiToken: required("JIRA_API_TOKEN"),
    projectKey,
    issueType: env.JIRA_ISSUE_TYPE ?? "Bug",
    projectKeys: [...new Set([projectKey, ...extraKeys])],
    minSeverity,
  };
}

/** api.github.com -> github.com; ghes.example.com/api/v3 -> ghes.example.com */
export function deriveWebBaseUrl(apiBaseUrl: string): string {
  const u = new URL(apiBaseUrl);
  if (u.hostname === "api.github.com") return "https://github.com";
  u.pathname = u.pathname.replace(/\/api\/v3\/?$/, "");
  return u.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiBaseUrl = (env.GITHUB_API_BASE_URL ?? "https://api.github.com").replace(
    /\/$/,
    "",
  );
  const port = Number(env.PORT ?? 3001);
  const publicUrl = (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  return {
    port,
    publicUrl,
    webUrl: (env.WEB_URL ?? publicUrl).replace(/\/$/, ""),
    slack: loadSlack(env),
    jira: loadJira(env),
    github: {
      appId: required("GITHUB_APP_ID"),
      appSlug: env.GITHUB_APP_SLUG,
      privateKey: loadPrivateKey(),
      webhookSecret: required("GITHUB_WEBHOOK_SECRET"),
      apiBaseUrl,
      webBaseUrl: deriveWebBaseUrl(apiBaseUrl),
    },
  };
}
