import { Hono } from "hono";
import type { BlockActionsPayload, SlackCommands, SlashCommandPayload } from "./commands";
import { verifySlackSignature } from "./verify";

export interface SlackRoutesDeps {
  signingSecret: string;
  commands: SlackCommands;
}

/**
 * Slack posts slash commands and interactions as form-encoded bodies. Both
 * routes verify the signature over the raw body before parsing anything.
 *
 *   POST /slack/commands      -> slash command (`/qa ...`)
 *   POST /slack/interactions  -> block_actions (button clicks)
 */
export function slackRoutes(deps: SlackRoutesDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    const raw = await c.req.text();
    const ok = verifySlackSignature(
      deps.signingSecret,
      raw,
      c.req.header("x-slack-request-timestamp"),
      c.req.header("x-slack-signature"),
    );
    if (!ok) return c.text("invalid signature", 401);
    c.set("rawBody", raw);
    await next();
  });

  app.post("/commands", async (c) => {
    const form = new URLSearchParams(c.get("rawBody"));
    const payload: SlashCommandPayload = {
      command: form.get("command") ?? "",
      text: form.get("text") ?? "",
      user_id: form.get("user_id") ?? "",
      user_name: form.get("user_name") ?? "unknown",
      channel_id: form.get("channel_id") ?? "",
      response_url: form.get("response_url") ?? "",
    };
    const reply = await deps.commands.handleSlashCommand(payload);
    return c.json(reply);
  });

  app.post("/interactions", async (c) => {
    const form = new URLSearchParams(c.get("rawBody"));
    const rawPayload = form.get("payload");
    if (!rawPayload) return c.text("missing payload", 400);

    let payload: { type?: string };
    try {
      payload = JSON.parse(rawPayload) as { type?: string };
    } catch {
      return c.text("malformed payload", 400);
    }

    if (payload.type === "block_actions") {
      // Fire-and-forget: Slack only needs the ack. Errors are reported back
      // to the user through response_url inside the handler.
      void deps.commands.handleBlockActions(payload as BlockActionsPayload).catch((err) => {
        console.error("[slack] block_actions handler failed:", err);
      });
    }
    return c.body(null, 200);
  });

  return app;
}

declare module "hono" {
  interface ContextVariableMap {
    rawBody: string;
  }
}
