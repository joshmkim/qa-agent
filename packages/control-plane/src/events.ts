import { EventEmitter } from "node:events";
import type { ChangeContext, Repository, Run, Stage } from "@qa-agent/shared-types";

/**
 * Domain events the control plane emits as runs move through their lifecycle.
 * Integrations (Slack, Checks, future webhooks) subscribe here instead of
 * being called from the run service directly, so adding a new sink never
 * touches core run logic.
 */
export interface DeploymentDetected {
  repository: Repository;
  stage: Stage;
  headSha: string;
  change: ChangeContext;
  /** Who/what produced the deployment, e.g. GitHub pusher login or "ci". */
  source: string;
  /** True when a run was started automatically for this deployment. */
  autoRun: boolean;
}

export interface RunStarted {
  repository: Repository;
  stage: Stage;
  run: Run;
}

export interface RunFinished {
  repository: Repository;
  stage: Stage;
  run: Run;
}

export interface EventMap {
  "deployment.detected": DeploymentDetected;
  "run.started": RunStarted;
  "run.finished": RunFinished;
}

type Handler<K extends keyof EventMap> = (event: EventMap[K]) => void | Promise<void>;

export class EventBus {
  private emitter = new EventEmitter();

  on<K extends keyof EventMap>(name: K, handler: Handler<K>): () => void {
    // Subscriber failures must never break the emitter's caller (a webhook
    // handler or slash command), so each handler is isolated.
    const wrapped = (event: EventMap[K]) => {
      Promise.resolve()
        .then(() => handler(event))
        .catch((err) => {
          console.error(`[events] handler for ${name} failed:`, err);
        });
    };
    this.emitter.on(name, wrapped);
    return () => this.emitter.off(name, wrapped);
  }

  emit<K extends keyof EventMap>(name: K, event: EventMap[K]): void {
    this.emitter.emit(name, event);
  }
}
