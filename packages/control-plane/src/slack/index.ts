import { WebClient } from "@slack/web-api";
import type { Run } from "@qa-agent/shared-types";
import type { SlackConfig } from "../config";
import type { EventBus } from "../events";
import { SlackNotifier } from "./notifier";

export interface SlackIntegration {
  notifier: SlackNotifier;
  client: WebClient;
  stop: () => void;
}

/** Wires the outbound Slack reporter to the run event bus. */
export function createSlackIntegration(deps: {
  config: SlackConfig;
  events: EventBus;
  runUrl: (run: Run) => string;
}): SlackIntegration {
  const client = new WebClient(deps.config.botToken);
  const notifier = new SlackNotifier({
    client,
    events: deps.events,
    channelId: deps.config.channelId,
    runUrl: deps.runUrl,
  });
  return { notifier, client, stop: notifier.start() };
}
