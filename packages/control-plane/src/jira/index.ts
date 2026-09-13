import type { Run } from "@qa-agent/shared-types";
import type { JiraConfig } from "../config";
import type { EventBus } from "../events";
import type { Store } from "../store";
import { JiraClient } from "./client";
import { JiraReporter } from "./reporter";

export interface JiraIntegration {
  client: JiraClient;
  reporter: JiraReporter;
  stop: () => void;
}

/** Wires the outbound Jira reporter to the run event bus. */
export function createJiraIntegration(deps: {
  config: JiraConfig;
  events: EventBus;
  store: Store;
  runUrl: (run: Run) => string;
}): JiraIntegration {
  const client = new JiraClient(deps.config);
  const reporter = new JiraReporter({
    client,
    events: deps.events,
    store: deps.store,
    config: deps.config,
    runUrl: deps.runUrl,
  });
  return { client, reporter, stop: reporter.start() };
}

export { JiraClient } from "./client";
export { extractJiraKeys, extractJiraKeysFrom, issueUrl } from "./keys";
