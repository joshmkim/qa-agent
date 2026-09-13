import type { ChangeContext, ChangedFile, PullRequestRef } from "@qa-agent/shared-types";
import { extractJiraKeysFrom } from "../jira/keys";
import type { InstallationOctokit } from "./app";

/** GitHub returns at most this many commits per compare page. */
const COMPARE_PAGE_SIZE = 250;
/** GitHub silently truncates the compare file list here. */
const COMPARE_FILE_CAP = 300;
/** Safety valve so a bad cursor can't make us walk the whole history. */
const MAX_COMMITS = 2000;
const PR_LOOKUP_CONCURRENCY = 8;

export interface RepoRef {
  owner: string;
  repo: string;
}

interface CompareCommit {
  sha: string;
  commit: { message: string };
}

interface CompareResult {
  status: ChangeContext["compareStatus"];
  mergeBaseSha: string;
  totalCommits: number;
  commits: CompareCommit[];
  /** files[] from the first page; GitHub caps it at COMPARE_FILE_CAP. */
  files: ChangedFile[];
}

async function compare(
  octokit: InstallationOctokit,
  ref: RepoRef,
  base: string,
  head: string,
): Promise<CompareResult> {
  const commits: CompareCommit[] = [];
  let status: CompareResult["status"] = "identical";
  let mergeBaseSha = base;
  let totalCommits = 0;
  let files: ChangedFile[] = [];

  for (let page = 1; commits.length < MAX_COMMITS; page++) {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      ...ref,
      basehead: `${base}...${head}`,
      per_page: COMPARE_PAGE_SIZE,
      page,
    });
    if (page === 1) {
      status = data.status;
      mergeBaseSha = data.merge_base_commit.sha;
      totalCommits = data.total_commits;
      files = (data.files ?? []).map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
    }
    commits.push(...data.commits.map((c) => ({ sha: c.sha, commit: { message: c.commit.message } })));
    if (data.commits.length < COMPARE_PAGE_SIZE || commits.length >= totalCommits) break;
  }

  return { status, mergeBaseSha, totalCommits, commits, files };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

const ISSUE_REF = /(?:^|[\s(])((?:[\w.-]+\/[\w.-]+)?#\d+)\b/g;
const ISSUE_URL = /https?:\/\/[^\s)]+\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/g;

/** Pull "#123", "owner/repo#123", and full issue URLs out of a PR body. */
export function extractLinkedIssues(body: string | null | undefined): string[] {
  if (!body) return [];
  const found = new Set<string>();
  for (const m of body.matchAll(ISSUE_REF)) found.add(m[1] as string);
  for (const m of body.matchAll(ISSUE_URL)) found.add(`${m[1]}#${m[2]}`);
  return [...found];
}

const REVERT_TITLE = /^Revert\s+"(.+)"\s*$/;
/** "Merge pull request #12 from ..." (merge commit) or "Title (#12)" (squash). */
const MERGE_MESSAGE = /^Merge pull request #(\d+)\b/;
const SQUASH_TITLE = /\(#(\d+)\)\s*$/;

/** PR number GitHub writes into merge and squash commit messages, if any. */
export function prNumberFromMessage(message: string): number | undefined {
  const firstLine = message.split("\n")[0] ?? "";
  const m = MERGE_MESSAGE.exec(firstLine) ?? SQUASH_TITLE.exec(firstLine);
  return m ? Number(m[1]) : undefined;
}

/**
 * A PR and its revert landing in the same window is a net no-op for QA
 * purposes. Drop both so agents don't chase changes that were undone.
 * Only exact title pairs are matched; partial reverts stay in the list.
 */
export function collapseReverts(prs: PullRequestRef[]): PullRequestRef[] {
  const byTitle = new Map<string, PullRequestRef[]>();
  for (const pr of prs) {
    const list = byTitle.get(pr.title) ?? [];
    list.push(pr);
    byTitle.set(pr.title, list);
  }
  const dropped = new Set<number>();
  for (const pr of prs) {
    const m = REVERT_TITLE.exec(pr.title);
    if (!m) continue;
    const original = (byTitle.get(m[1] as string) ?? []).find(
      (o) => !dropped.has(o.number) && o.mergedAt < pr.mergedAt,
    );
    if (original) {
      dropped.add(original.number);
      dropped.add(pr.number);
    }
  }
  return prs.filter((pr) => !dropped.has(pr.number));
}

async function enrichPullRequests(
  octokit: InstallationOctokit,
  ref: RepoRef,
  commits: CompareCommit[],
): Promise<PullRequestRef[]> {
  // Merge commits and squash commits both map back to their PR through this
  // endpoint; unmerged/draft PRs are filtered out below. GitHub indexes the
  // association a few seconds after a merge, so a push webhook for the merge
  // can see nothing; fall back to the PR number in the commit message, which
  // is verified as merged by the pulls.get below.
  const perCommit = await mapWithConcurrency(commits, PR_LOOKUP_CONCURRENCY, async (c) => {
    const { data } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      ...ref,
      commit_sha: c.sha,
    });
    const merged = data.filter((pr) => pr.merged_at !== null).map((pr) => pr.number);
    if (merged.length > 0) return merged;
    const fromMessage = prNumberFromMessage(c.commit.message);
    return fromMessage === undefined ? [] : [fromMessage];
  });

  const numbers = [...new Set(perCommit.flat())].sort((a, b) => a - b);

  const prs = await mapWithConcurrency(numbers, PR_LOOKUP_CONCURRENCY, async (pull_number) => {
    let pr;
    try {
      ({ data: pr } = await octokit.rest.pulls.get({ ...ref, pull_number }));
    } catch (err) {
      // A "(#123)" in a commit title can point at a PR that doesn't exist here.
      if ((err as { status?: number }).status === 404) return undefined;
      throw err;
    }
    if (pr.merged_at === null) return undefined;
    const out: PullRequestRef = {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      author: pr.user?.login ?? "unknown",
      labels: pr.labels.map((l) => l.name),
      linkedIssues: extractLinkedIssues(pr.body),
      url: pr.html_url,
      mergedAt: pr.merged_at ?? "",
      filesChanged: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
    };
    return out;
  });

  const merged = prs.filter((pr): pr is PullRequestRef => pr !== undefined);
  merged.sort((a, b) => a.mergedAt.localeCompare(b.mergedAt));
  return collapseReverts(merged);
}

/**
 * Diff between the last deployed cursor and the current head, enriched with
 * the PRs that landed in between. This is the "change context" agents get.
 *
 * - "diverged" (base not an ancestor of head, e.g. after a force-push or a
 *   branch-promotion merge) falls back to comparing from the merge base.
 * - Commit list is paginated past GitHub's 250/page cap.
 * - File count past the 300-file cap is reconstructed from PR metadata, and
 *   `filesTruncated` tells agents the file list is incomplete.
 * - `jiraProjectKeys` turns on issue-key scanning of PR titles, bodies and
 *   commit messages; empty means no Jira is configured and none is recorded.
 */
export async function computeChangeContext(
  octokit: InstallationOctokit,
  ref: RepoRef,
  baseSha: string,
  headSha: string,
  jiraProjectKeys: string[] = [],
): Promise<ChangeContext> {
  let result = await compare(octokit, ref, baseSha, headSha);
  let effectiveBase = baseSha;

  if (result.status === "diverged" && result.mergeBaseSha !== baseSha) {
    effectiveBase = result.mergeBaseSha;
    const fromMergeBase = await compare(octokit, ref, effectiveBase, headSha);
    // Keep the original status so callers know we fell back.
    result = { ...fromMergeBase, status: "diverged" };
  }

  const pullRequests = await enrichPullRequests(octokit, ref, result.commits);

  const filesTruncated = result.files.length >= COMPARE_FILE_CAP;
  const filesChanged =
    filesTruncated && pullRequests.length > 0
      ? pullRequests.reduce((n, pr) => n + pr.filesChanged, 0)
      : result.files.length;

  const jiraKeys = extractJiraKeysFrom(
    [
      ...pullRequests.flatMap((pr) => [pr.title, pr.body]),
      ...result.commits.map((c) => c.commit.message),
    ],
    jiraProjectKeys,
  );

  return {
    baseSha: effectiveBase,
    headSha,
    commitCount: result.totalCommits,
    filesChanged,
    pullRequests,
    compareStatus: result.status,
    ...(jiraKeys.length > 0 ? { jiraKeys } : {}),
    changedFiles: result.files,
    filesTruncated,
  };
}
