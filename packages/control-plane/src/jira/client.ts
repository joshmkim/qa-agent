import type { JiraConfig } from "../config";

/** Atlassian Document Format node. Jira Cloud REST v3 takes rich text as ADF. */
export type AdfNode = { type: string; [key: string]: unknown };

export interface CreatedIssue {
  key: string;
  url: string;
}

export class JiraError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "JiraError";
  }
}

/**
 * Minimal Jira Cloud client: create an issue, find one by label, comment on
 * one. Auth is HTTP Basic with `email:api_token`, which is what Atlassian
 * issues for a personal account (no OAuth app, no public URL).
 *
 * Everything here is outbound, so the control plane needs network access to
 * the site but Jira never calls back into it.
 */
export class JiraClient {
  private readonly auth: string;

  constructor(private readonly config: JiraConfig) {
    this.auth = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JiraError(`Jira ${method} ${path} failed: ${res.status}`, res.status, text);
    }
    // 204 on comment/transition endpoints.
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  /** The issue key of the first match for a JQL query, if any. */
  async findIssueByLabel(label: string): Promise<string | undefined> {
    const jql = `project = "${this.config.projectKey}" AND labels = "${label}" ORDER BY created DESC`;
    const data = await this.request<{ issues?: { key: string }[] }>("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: 1,
      fields: ["key"],
    });
    return data.issues?.[0]?.key;
  }

  async createIssue(fields: Record<string, unknown>): Promise<CreatedIssue> {
    const data = await this.request<{ key: string }>("POST", "/rest/api/3/issue", { fields });
    return { key: data.key, url: `${this.config.baseUrl}/browse/${data.key}` };
  }

  async addComment(issueKey: string, body: AdfNode): Promise<void> {
    await this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, { body });
  }

  /** Cheap credential + project check used at startup. */
  async verifyAccess(): Promise<void> {
    await this.request("GET", `/rest/api/3/project/${encodeURIComponent(this.config.projectKey)}`);
  }
}
