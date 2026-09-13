import type { WebClient } from "@slack/web-api";
import type { Run } from "@qa-agent/shared-types";
import type { DeploymentFailed, EventBus, FindingTracked } from "../events";
import { deploymentFailedMessage, findingTrackedMessage, runReportMessage } from "./blocks";

export interface NotifierDeps {
  client: WebClient;
  events: EventBus;
  /** Channel that receives run reports. */
  channelId: string;
  runUrl: (run: Run) => string;
}

/**
 * Posts a report to Slack when a run finishes, a short notice when a
 * deployment could not be assessed at all, and a ping when a finding is
 * newly filed in an external tracker (Jira today). Outbound only: this needs
 * a bot token and network access to slack.com, but no public URL, since
 * Slack never calls back into the control plane.
 */
export class SlackNotifier {
  constructor(private readonly deps: NotifierDeps) {}

  start(): () => void {
    const offs = [
      this.deps.events.on("run.finished", (e) => this.onRunFinished(e)),
      this.deps.events.on("deployment.failed", (e) => this.onDeploymentFailed(e)),
      this.deps.events.on("finding.tracked", (e) => this.onFindingTracked(e)),
    ];
    return () => offs.forEach((off) => off());
  }

  private async onFindingTracked(e: FindingTracked): Promise<void> {
    const runLink = this.deps.runUrl(e.run);
    const msg = findingTrackedMessage({
      repository: e.repository,
      stage: e.stage,
      run: e.run,
      finding: e.finding,
      runUrl: runLink,
      findingUrl: `${runLink}/findings/${e.finding.id}`,
    });
    await this.deps.client.chat.postMessage({
      channel: this.deps.channelId,
      text: msg.text,
      blocks: msg.blocks,
      unfurl_links: false,
    });
  }

  private async onDeploymentFailed(e: DeploymentFailed): Promise<void> {
    const msg = deploymentFailedMessage({ ...e, runUrl: this.deps.runUrl(e.run) });
    await this.deps.client.chat.postMessage({
      channel: this.deps.channelId,
      text: msg.text,
      blocks: msg.blocks,
      unfurl_links: false,
    });
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
