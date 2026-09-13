import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Run } from "@qa-agent/shared-types";
import { apiRoutes } from "./api";
import { loadConfig } from "./config";
import { devRoutes } from "./dev";
import { EventBus } from "./events";
import { createGitHubApp } from "./github/app";
import { githubOnboarding } from "./github/onboarding";
import { githubWebhooks } from "./github/webhooks";
import { RunService } from "./runs/service";
import { createSlackIntegration } from "./slack";
import { MemoryStore } from "./store/memory";

const config = loadConfig();
const store = new MemoryStore();
const events = new EventBus();
const github = createGitHubApp(config.github);

const runUrl = (run: Run) => `${config.webUrl}/pipelines/${run.repositoryId}/runs/${run.id}`;

const runs = new RunService({ store, github, events, runUrl });

const app = new Hono();
app.get("/healthz", (c) => c.json({ ok: true, slack: Boolean(config.slack) }));
app.route("/webhooks", githubWebhooks({ github, store, runs, webBaseUrl: config.github.webBaseUrl }));
app.route("/github", githubOnboarding({ github, store, config: config.github }));
app.route("/api", apiRoutes({ store, runs }));

if (process.env.DEV_SEED === "true") {
  app.route("/dev", devRoutes(store));
  console.log("[dev] seed route enabled at POST /dev/seed");
}

if (config.slack) {
  const slack = createSlackIntegration({ config: config.slack, events, runs, store, runUrl });
  app.route("/slack", slack.routes);
  console.log(`[slack] enabled; notifying channel ${config.slack.channelId}`);
} else {
  console.log("[slack] disabled (SLACK_BOT_TOKEN not set)");
}

// Always log lifecycle events so runs are traceable without Slack.
events.on("deployment.detected", (e) =>
  console.log(`[deploy] ${e.repository.fullName}@${e.stage.branch} -> ${e.headSha.slice(0, 7)} (${e.change.pullRequests.length} PRs, autoRun=${e.autoRun})`),
);
events.on("run.started", (e) => console.log(`[run] #${e.run.number} started on ${e.repository.fullName} ${e.stage.name} (${e.run.trigger})`));
events.on("run.finished", (e) => console.log(`[run] #${e.run.number} finished: ${e.run.status} / ${e.run.verdict}`));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`control-plane listening on http://localhost:${info.port}`);
});
