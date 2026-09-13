import { readFileSync } from "node:fs";

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
  /** Used to verify slash command / interaction requests. */
  signingSecret: string;
  /** Channel that receives deployment and run notifications. */
  channelId: string;
}

export interface Config {
  port: number;
  publicUrl: string;
  /** Web UI base for run links. Falls back to publicUrl. */
  webUrl: string;
  github: GitHubConfig;
  /** Undefined when SLACK_BOT_TOKEN is unset; the bot is then disabled. */
  slack?: SlackConfig;
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
    signingSecret: required("SLACK_SIGNING_SECRET"),
    channelId: required("SLACK_CHANNEL_ID"),
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
