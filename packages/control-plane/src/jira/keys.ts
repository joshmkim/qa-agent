/**
 * Jira issue keys are `PROJ-123`. The shape alone matches plenty of things
 * that aren't issues ("UTF-8", "SHA-1", "ISO-8601"), so callers pass the
 * project prefixes they actually use and everything else is dropped.
 */
const ISSUE_KEY = /\b([A-Z][A-Z0-9_]{1,9})-(\d+)\b/g;

/** Keys from one blob of text, filtered to `projectKeys`, in first-seen order. */
export function extractJiraKeys(text: string | null | undefined, projectKeys: string[]): string[] {
  if (!text || projectKeys.length === 0) return [];
  const allowed = new Set(projectKeys.map((k) => k.toUpperCase()));
  const found = new Set<string>();
  for (const m of text.matchAll(ISSUE_KEY)) {
    const project = (m[1] as string).toUpperCase();
    if (allowed.has(project)) found.add(`${project}-${m[2]}`);
  }
  return [...found];
}

/** Keys across many texts (PR titles, bodies, commit messages), deduped. */
export function extractJiraKeysFrom(texts: (string | null | undefined)[], projectKeys: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const key of extractJiraKeys(text, projectKeys)) found.add(key);
  }
  return [...found];
}

/** Browse URL for an issue key on a site. */
export function issueUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/$/, "")}/browse/${key}`;
}
