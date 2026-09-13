import type { WebClient } from "@slack/web-api";
import type { Run } from "@qa-agent/shared-types";
import type { DeploymentFailed, EventBus } from "../events";
import { deploymentFailedMessage, deploymentMessage, runReportMessage, runStartedMessage } from "./blocks";

export interface NotifierDeps {
  client: WebClient;
  events: EventBus;
  /** Default channel for deployment and run notifications. */
  channelId: string;
  runUrl: (run: Run) => string;
}

interface PostedMessage {
  channel: string;
  ts: string;
}

/**
 * Turns run lifecycle events into Slack messages:
 *
 *   deployment.detected -> new message (with a kickoff button if not auto-run)
 *   deployment.failed   -> short standalone notice, no thread
 *   run.started         -> edits the deployment message in place, or posts a
 *                          fresh one for manual/API-triggered runs
 *   run.finished        -> report threaded under the run's message and
 *                          broadcast to the channel
 *
 * Message handles live in memory: a restart loses threading, not messages.
 */
export class SlackNotifier {
  /** stageId:headSha -> the deployment announcement awaiting a run. */
  private pendingDeployments = new Map<string, PostedMessage>();
  /** runId -> the "run started" message to thread the report under. */
  private runMessages = new Map<string, PostedMessage>();

  constructor(private readonly deps: NotifierDeps) {}

  start(): () => void {
    const { events } = this.deps;
    const offs = [
      events.on("deployment.detected", (e) => this.onDeployment(e)),
      events.on("deployment.failed", (e) => this.onDeploymentFailed(e)),
      events.on("run.started", (e) => this.onRunStarted(e)),
      events.on("run.finished", (e) => this.onRunFinished(e)),
    ];
    return () => offs.forEach((off) => off());
  }

  private key(stageId: string, headSha: string): string {
    return `${stageId}:${headSha}`;
  }

  private async onDeployment(e: Parameters<typeof deploymentMessage>[0]): Promise<void> {
    const msg = deploymentMessage(e);
    const res = await this.deps.client.chat.postMessage({
      channel: this.deps.channelId,
      text: msg.text,
      blocks: msg.blocks,
      unfurl_links: false,
    });
    if (res.ts) {
      this.pendingDeployments.set(this.key(e.stage.id, e.headSha), {
        channel: res.channel ?? this.deps.channelId,
        ts: res.ts,
      });
    }
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

  private async onRunStarted(e: {
    repository: Parameters<typeof runStartedMessage>[0]["repository"];
    stage: Parameters<typeof runStartedMessage>[0]["stage"];
    run: Run;
  }): Promise<void> {
    const msg = runStartedMessage({ ...e, runUrl: this.deps.runUrl(e.run) });
    const key = this.key(e.stage.id, e.run.change.headSha);
    const pending = this.pendingDeployments.get(key);

    if (pending) {
      this.pendingDeployments.delete(key);
      await this.deps.client.chat.update({
        channel: pending.channel,
        ts: pending.ts,
        text: msg.text,
        blocks: msg.blocks,
      });
      this.runMessages.set(e.run.id, pending);
      return;
    }

    const res = await this.deps.client.chat.postMessage({
      channel: this.deps.channelId,
      text: msg.text,
      blocks: msg.blocks,
      unfurl_links: false,
    });
    if (res.ts) {
      this.runMessages.set(e.run.id, { channel: res.channel ?? this.deps.channelId, ts: res.ts });
    }
  }

  private async onRunFinished(e: {
    repository: Parameters<typeof runReportMessage>[0]["repository"];
    stage: Parameters<typeof runReportMessage>[0]["stage"];
    run: Run;
  }): Promise<void> {
    const msg = runReportMessage({ ...e, runUrl: this.deps.runUrl(e.run) });
    const parent = this.runMessages.get(e.run.id);
    this.runMessages.delete(e.run.id);

    const base = {
      channel: parent?.channel ?? this.deps.channelId,
      text: msg.text,
      blocks: msg.blocks,
      unfurl_links: false,
    };
    // Thread under the start message but also show in the channel so the
    // verdict is visible without expanding the thread. Two explicit calls
    // because @slack/web-api types `reply_broadcast` as requiring `thread_ts`.
    if (parent) {
      await this.deps.client.chat.postMessage({ ...base, thread_ts: parent.ts, reply_broadcast: true });
    } else {
      await this.deps.client.chat.postMessage(base);
    }
  }
}
