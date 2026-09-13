import type { WebClient } from "@slack/web-api";
import type { Run } from "@qa-agent/shared-types";
import type { EventBus } from "../events";
import { runReportMessage } from "./blocks";

export interface NotifierDeps {
  client: WebClient;
  events: EventBus;
  /** Channel that receives run reports. */
  channelId: string;
  runUrl: (run: Run) => string;
}

/**
 * Posts a report to Slack when a run finishes. Outbound only: this needs a
 * bot token and network access to slack.com, but no public URL, since Slack
 * never calls back into the control plane.
 */
export class SlackNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  start(): () => void {
    return this.deps.events.on("run.finished", (e) => this.onRunFinished(e));
  }

  private async onRunFinished(e: {
    repository: Parameters<typeof runReportMessage>[0]["repository"];
    stage: Parameters<typeof runReportMessage>[0]["stage"];
    run: Run;
  }): Promise<void> {
    const msg = runReportMessage({ ...e, runUrl: this.deps.runUrl(e.run) });
    await this.deps.client.chat.postMessage({
      channel: this.deps.channelId,
      text: msg.text,
      blocks: msg.blocks,
      unfurl_links: false,
    });
  }
}
