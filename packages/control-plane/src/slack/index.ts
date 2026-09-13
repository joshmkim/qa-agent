import { WebClient } from "@slack/web-api";
import type { Hono } from "hono";
import type { Run } from "@qa-agent/shared-types";
import type { SlackConfig } from "../config";
import type { EventBus } from "../events";
import type { RunService } from "../runs/service";
import type { Store } from "../store";
import { SlackCommands } from "./commands";
import { SlackNotifier } from "./notifier";
import { slackRoutes } from "./routes";

export interface SlackIntegration {
  routes: Hono;
  notifier: SlackNotifier;
  commands: SlackCommands;
  client: WebClient;
  stop: () => void;
}

/**
 * Wires the Slack bot: outbound notifications driven by run events, and
 * inbound slash commands / button clicks that drive the run service.
 */
export function createSlackIntegration(deps: {
  config: SlackConfig;
  events: EventBus;
  runs: RunService;
  store: Store;
  runUrl: (run: Run) => string;
}): SlackIntegration {
  const client = new WebClient(deps.config.botToken);

  const notifier = new SlackNotifier({
    client,
    events: deps.events,
    channelId: deps.config.channelId,
    runUrl: deps.runUrl,
  });
  const stop = notifier.start();

  const commands = new SlackCommands({
    runs: deps.runs,
    store: deps.store,
    runUrl: deps.runUrl,
  });

  return {
    routes: slackRoutes({ signingSecret: deps.config.signingSecret, commands }),
    notifier,
    commands,
    client,
    stop,
  };
}
