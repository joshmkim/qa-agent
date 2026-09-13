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
import { createJiraIntegration } from "./jira";
import { InProcessAgentRunner, Orchestrator } from "./orchestrator";
import { RunService } from "./runs/service";
import { createSlackIntegration } from "./slack";
import { createStore } from "./store/create";

const config = loadConfig();
const { store, close } = await createStore(process.env);
const events = new EventBus();
const github = createGitHubApp(config.github);

const runUrl = (run: Run) => `${config.webUrl}/pipelines/${run.repositoryId}/runs/${run.id}`;

const runs = new RunService({ store, github, events, runUrl, jiraProjectKeys: config.jira?.projectKeys });

const app = new Hono();
app.get("/healthz", (c) => c.json({ ok: true, slack: Boolean(config.slack), jira: Boolean(config.jira) }));
app.route("/webhooks", githubWebhooks({ github, store, runs, webBaseUrl: config.github.webBaseUrl }));
app.route("/github", githubOnboarding({ github, store, config: config.github }));
app.route("/api", apiRoutes({ store, runs }));

if (process.env.DEV_SEED === "true") {
  app.route("/dev", devRoutes(store));
  console.log("[dev] seed route enabled at POST /dev/seed");
}

if (config.orchestrator) {
  const o = config.orchestrator;
  new Orchestrator({
    runs,
    events,
    runner: new InProcessAgentRunner({ headless: o.headless, maxSteps: o.maxSteps, recordVideo: o.recordVideo, log: (m) => console.log(m) }),
    config: o,
  }).start();
  console.log(`[orchestrator] enabled; ${o.concurrency} agents in flight, fleet cap ${o.maxFleetSize || "none"}, budget from stage (default ${o.agentBudgetSeconds}s)`);
} else {
  console.log("[orchestrator] disabled (ANTHROPIC_API_KEY not set); runs stay queued until completed via the API");
}

if (config.slack) {
  createSlackIntegration({ config: config.slack, events, runUrl });
  console.log(`[slack] enabled; run reports go to channel ${config.slack.channelId}`);
} else {
  console.log("[slack] disabled (SLACK_BOT_TOKEN not set)");
}

if (config.jira) {
  const jira = createJiraIntegration({ config: config.jira, events, store, runUrl });
  console.log(
    `[jira] enabled; ${config.jira.minSeverity}+ findings file into ${config.jira.projectKey} as "${config.jira.issueType}"`,
  );
  // Surfaces a bad token, wrong site, or missing project at boot rather than
  // on the first finished run, an hour into a demo.
  jira.client.verifyAccess().catch((err) => {
    console.error(`[jira] cannot reach project ${config.jira?.projectKey}; issues will not be filed:`, err.message);
  });
} else {
  console.log("[jira] disabled (JIRA_BASE_URL not set)");
}

// Always log lifecycle events so runs are traceable without Slack.
events.on("deployment.detected", (e) =>
  console.log(`[deploy] ${e.repository.fullName}@${e.stage.branch} -> ${e.headSha.slice(0, 7)} (${e.change.pullRequests.length} PRs, autoRun=${e.autoRun})`),
);
events.on("run.started", (e) => console.log(`[run] #${e.run.number} started on ${e.repository.fullName} ${e.stage.name} (${e.run.trigger})`));
events.on("run.finished", (e) => console.log(`[run] #${e.run.number} finished: ${e.run.status} / ${e.run.verdict}`));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`control-plane listening on http://localhost:${info.port}`);
});

// Release the port and database connections on Ctrl+C and on tsx watch reloads.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void close().finally(() => process.exit(0));
  });
}
