import { Hono } from "hono";
import type { Repository } from "@qa-agent/shared-types";
import type { RunService } from "../runs/service";
import type { Installation, Store } from "../store";
import type { GitHubApp } from "./app";

export interface WebhookDeps {
  github: GitHubApp;
  store: Store;
  runs: RunService;
  /** e.g. https://github.com; used to build repo URLs from slim payloads. */
  webBaseUrl: string;
}

interface PayloadRepo {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  default_branch?: string;
  owner: { login: string };
}

function toRepository(r: PayloadRepo, installationId: number): Repository {
  return {
    id: String(r.id),
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? "main",
    installationId,
    url: r.html_url,
  };
}

/**
 * Registers handlers on the App's webhook dispatcher and returns the Hono
 * router that receives deliveries. Signature is verified over the raw body,
 * deliveries are deduped on X-GitHub-Delivery, and we ack 200 before doing
 * any work so GitHub never sees a timeout.
 */
export function githubWebhooks(deps: WebhookDeps): Hono {
  const { github, store, runs, webBaseUrl } = deps;

  /** Installation events only carry id/name/full_name; default branch is unknown until first push. */
  const fromSlimRepo = (r: { id: number; name: string; full_name: string }, installationId: number): Repository =>
    toRepository(
      {
        ...r,
        html_url: `${webBaseUrl}/${r.full_name}`,
        owner: { login: r.full_name.split("/")[0] ?? "" },
      },
      installationId,
    );

  github.webhooks.on(["installation.created", "installation.unsuspend"], async ({ payload }) => {
    const inst: Installation = {
      installationId: payload.installation.id,
      accountLogin: payload.installation.account?.login ?? "unknown",
      accountType: payload.installation.account?.type === "User" ? "User" : "Organization",
      repositorySelection: payload.installation.repository_selection,
      suspended: false,
      installedAt: new Date().toISOString(),
    };
    await store.upsertInstallation(inst);
    for (const r of payload.repositories ?? []) {
      await store.upsertRepository(fromSlimRepo(r, inst.installationId));
    }
  });

  github.webhooks.on("installation.suspend", async ({ payload }) => {
    const existing = await store.getInstallation(payload.installation.id);
    if (existing) await store.upsertInstallation({ ...existing, suspended: true });
  });

  github.webhooks.on("installation.deleted", async ({ payload }) => {
    await store.deleteInstallation(payload.installation.id);
  });

  github.webhooks.on("installation_repositories", async ({ payload }) => {
    for (const r of payload.repositories_added) {
      await store.upsertRepository(fromSlimRepo(r, payload.installation.id));
    }
    for (const r of payload.repositories_removed) {
      await store.deleteRepository(String(r.id));
    }
  });

  github.webhooks.on("push", async ({ payload }) => {
    if (payload.deleted || !payload.ref.startsWith("refs/heads/")) return;
    const branch = payload.ref.slice("refs/heads/".length);
    const installationId = payload.installation?.id;
    if (installationId === undefined) return;

    // Repos granted via "all repositories" never arrive in an installation
    // event, so we learn about them lazily from their first push.
    const repo = toRepository(payload.repository, installationId);
    await store.upsertRepository(repo);

    const stage = await store.findStageByBranch(repo.id, branch);
    if (!stage) return;
    if (stage.cursor?.sha === payload.after) return; // already at this head

    try {
      await runs.detectDeployment(stage, payload.after, payload.pusher.name);
    } catch (err) {
      console.error(`[webhooks] deployment handling failed for ${repo.fullName}@${branch}:`, err);
    }
  });

  github.webhooks.onError((err) => {
    console.error("[webhooks] handler error:", err);
  });

  const app = new Hono();
  app.post("/github", async (c) => {
    const id = c.req.header("x-github-delivery");
    const name = c.req.header("x-github-event");
    const signature = c.req.header("x-hub-signature-256");
    if (!id || !name || !signature) return c.text("missing headers", 400);

    const raw = await c.req.text();
    if (!(await github.webhooks.verify(raw, signature))) {
      return c.text("invalid signature", 401);
    }
    if (!(await store.claimDelivery(id))) {
      return c.text("duplicate delivery", 200);
    }

    // Ack first; handlers run after the response is sent.
    void github.webhooks
      .receive({ id, name: name as never, payload: JSON.parse(raw) })
      .catch((err) => console.error(`[webhooks] ${name} ${id} failed:`, err));

    return c.text("ok", 202);
  });
  return app;
}
