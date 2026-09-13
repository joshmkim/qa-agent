import type { KnownBlock } from "@slack/web-api";
import type { Run, Stage } from "@qa-agent/shared-types";
import { RunError, type RunService } from "../runs/service";
import type { Store } from "../store";
import { RUN_QA_ACTION, stageStatusText, type RunQaButtonValue } from "./blocks";

/** Fields we use from Slack's slash command form post. */
export interface SlashCommandPayload {
  command: string;
  text: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  response_url: string;
}

/** Subset of a `block_actions` interaction payload. */
export interface BlockActionsPayload {
  type: "block_actions";
  user: { id: string; username: string };
  actions: Array<{ action_id: string; value?: string }>;
  response_url: string;
}

export interface CommandReply {
  response_type: "ephemeral" | "in_channel";
  text: string;
  blocks?: KnownBlock[];
  replace_original?: boolean;
}

export interface CommandsDeps {
  runs: RunService;
  store: Store;
  runUrl: (run: Run) => string;
  /** Posts a follow-up to a Slack response_url. Injected for testability. */
  respond?: (responseUrl: string, reply: CommandReply) => Promise<void>;
}

const HELP = [
  "*Agentic QA Fleet*",
  "`/qa run <owner/repo> <stage> [sha]` — kick off the fleet against a stage's current head (or a specific SHA)",
  "`/qa status <owner/repo> [stage]` — latest run and cursor per stage",
  "`/qa help` — this message",
].join("\n");

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

async function postToResponseUrl(responseUrl: string, reply: CommandReply): Promise<void> {
  const res = await fetch(responseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(reply),
  });
  if (!res.ok) {
    throw new Error(`Slack response_url returned ${res.status}`);
  }
}

function ephemeral(text: string): CommandReply {
  return { response_type: "ephemeral", text };
}

function describeError(err: unknown): string {
  if (err instanceof RunError) return err.message;
  if (err instanceof Error) return `Unexpected error: ${err.message}`;
  return "Unexpected error";
}

/**
 * `/qa ...` slash commands and button clicks. Slack needs a 200 within three
 * seconds, so anything that talks to GitHub is acked immediately and finished
 * in the background; results land in the channel via the notifier, and
 * errors go back to the caller through response_url.
 */
export class SlackCommands {
  private readonly respond: NonNullable<CommandsDeps["respond"]>;

  constructor(private readonly deps: CommandsDeps) {
    this.respond = deps.respond ?? postToResponseUrl;
  }

  async handleSlashCommand(payload: SlashCommandPayload): Promise<CommandReply> {
    const [verb = "help", ...args] = payload.text.trim().split(/\s+/).filter(Boolean);

    switch (verb.toLowerCase()) {
      case "run":
        return this.run(payload, args);
      case "status":
        return this.status(args);
      case "help":
        return ephemeral(HELP);
      default:
        return ephemeral(`Unknown subcommand \`${verb}\`.\n\n${HELP}`);
    }
  }

  private async run(payload: SlashCommandPayload, args: string[]): Promise<CommandReply> {
    const [repoName, stageName, sha] = args;
    if (!repoName || !stageName) {
      return ephemeral("Usage: `/qa run <owner/repo> <stage> [sha]`");
    }
    if (!REPO_RE.test(repoName)) {
      return ephemeral(`\`${repoName}\` doesn't look like \`owner/repo\`.`);
    }
    if (sha !== undefined && !SHA_RE.test(sha)) {
      return ephemeral(`\`${sha}\` doesn't look like a commit SHA.`);
    }

    let stage: Stage;
    try {
      ({ stage } = await this.deps.runs.resolveStage(repoName, stageName));
    } catch (err) {
      return ephemeral(describeError(err));
    }
    if (!stage.cursor) {
      return ephemeral(
        `Stage *${stage.name}* on ${repoName} has no deploy cursor yet. Seed one first so we know what to diff against.`,
      );
    }

    // Ack now; GitHub compare + check run creation can exceed Slack's budget.
    void this.kickoff(stage, sha, `@${payload.user_name}`, payload.response_url);

    return ephemeral(
      `Kicking off the QA fleet on *${repoName} → ${stage.name}*` +
        (sha ? ` at \`${sha.slice(0, 7)}\`` : "") +
        `… I'll post in the channel when it starts.`,
    );
  }

  private async kickoff(
    stage: Stage,
    sha: string | undefined,
    triggeredBy: string,
    responseUrl: string,
  ): Promise<void> {
    try {
      const headSha = sha ?? (await this.deps.runs.branchHead(stage));
      await this.deps.runs.startRun({ stage, headSha, trigger: "manual", triggeredBy });
    } catch (err) {
      console.error("[slack] /qa run failed:", err);
      await this.respond(responseUrl, ephemeral(`Couldn't start the run: ${describeError(err)}`)).catch(
        (e) => console.error("[slack] failed to report error to response_url:", e),
      );
    }
  }

  private async status(args: string[]): Promise<CommandReply> {
    const [repoName, stageName] = args;
    if (!repoName) return ephemeral("Usage: `/qa status <owner/repo> [stage]`");
    if (!REPO_RE.test(repoName)) {
      return ephemeral(`\`${repoName}\` doesn't look like \`owner/repo\`.`);
    }

    const repository = await this.deps.store.getRepositoryByFullName(repoName);
    if (!repository) return ephemeral(`Repository ${repoName} is not connected.`);

    let stages = await this.deps.store.listStages(repository.id);
    if (stageName) {
      stages = stages.filter((s) => s.name.toLowerCase() === stageName.toLowerCase());
      if (stages.length === 0) return ephemeral(`Stage "${stageName}" not found on ${repoName}.`);
    }
    if (stages.length === 0) return ephemeral(`${repoName} has no stages configured.`);

    const lines = await Promise.all(
      stages.map(async (stage) => {
        const latest = stage.latestRunId ? await this.deps.store.getRun(stage.latestRunId) : undefined;
        return stageStatusText({
          repository,
          stage,
          latest,
          runUrl: latest ? this.deps.runUrl(latest) : undefined,
        });
      }),
    );
    return ephemeral(lines.join("\n\n"));
  }

  /** Button clicks. Only `run_qa` does work; link buttons just need the 200. */
  async handleBlockActions(payload: BlockActionsPayload): Promise<void> {
    for (const action of payload.actions) {
      if (action.action_id !== RUN_QA_ACTION || !action.value) continue;

      let value: RunQaButtonValue;
      try {
        value = JSON.parse(action.value) as RunQaButtonValue;
      } catch {
        console.error("[slack] malformed run_qa button value:", action.value);
        continue;
      }

      const stage = await this.deps.store.getStage(value.stageId);
      if (!stage) {
        await this.respond(payload.response_url, {
          ...ephemeral("That stage no longer exists."),
          replace_original: false,
        });
        continue;
      }

      // The notifier edits the deployment message in place when run.started
      // fires for this stage/head, so the button disappears for everyone.
      void this.deps.runs
        .startRun({
          stage,
          headSha: value.headSha,
          trigger: "manual",
          triggeredBy: `@${payload.user.username}`,
        })
        .catch(async (err) => {
          console.error("[slack] run_qa button failed:", err);
          const text =
            err instanceof RunError && err.code === "cursor-conflict"
              ? "Looks like someone already started a run for this deployment."
              : `Couldn't start the run: ${describeError(err)}`;
          await this.respond(payload.response_url, { ...ephemeral(text), replace_original: false }).catch(
            (e) => console.error("[slack] failed to report error to response_url:", e),
          );
        });
    }
  }
}
