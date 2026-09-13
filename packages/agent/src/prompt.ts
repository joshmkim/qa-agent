import type { ChangeContext, ChangedFile, ContextBundle, Disposition, Surface } from "@qa-agent/shared-types";

/** Character budget for rendered patches. ~4 chars/token; keep well under context. */
const DEFAULT_PATCH_BUDGET = 60_000;
const PER_FILE_PATCH_CAP = 8_000;

const DISPOSITIONS: Record<Disposition, string> = {
  methodical:
    "You are methodical. Work through your focus surfaces one at a time, complete every flow end to end, verify totals and copy against the invariants, and record each surface as visited before moving on.",
  "chaos-monkey":
    "You are a chaos monkey. Do the unexpected: double-click submit buttons, go back mid-flow, refresh during loading, open the same page twice, hit browser back after a form post, mix steps out of order, leave required fields empty, paste emoji and 10,000-character strings. Watch the console and network for anything the UI hides.",
  "adversarial-fuzzer":
    "You are an adversarial fuzzer. Probe inputs and endpoints with boundary values: 0, -1, huge numbers, unicode, HTML/script fragments, SQL-looking strings, malformed ids in URLs, other users' ids, expired or empty tokens. Use call_api to hit endpoints directly with what the UI would never send. Stay inside the blast-radius boundaries.",
  "impatient-user":
    "You are an impatient real user. Move fast, skip instructions, click the first plausible thing, don't wait for spinners, use the browser back button, abandon and resume flows. Notice anything confusing, slow, or that silently fails to react.",
};

function fileGroupKey(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0] ?? path;
}

/** Files whose path shares a token with a surface's locator or name are shown first. */
function relevanceScore(file: ChangedFile, surfaces: Surface[]): number {
  const lower = file.path.toLowerCase();
  let score = 0;
  for (const s of surfaces) {
    const tokens = [s.name, s.locator, s.id]
      .join(" ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4);
    if (tokens.some((t) => lower.includes(t))) score += s.touchedByChange ? 3 : 1;
  }
  if (/\.(test|spec)\.|__tests__|\.md$|\.lock$|package-lock|pnpm-lock|\.snap$/.test(lower)) score -= 5;
  return score;
}

export function renderChange(change: ChangeContext, surfaces: Surface[], patchBudget = DEFAULT_PATCH_BUDGET): string {
  const lines: string[] = [];
  lines.push(`Compare ${change.baseSha.slice(0, 7)}...${change.headSha.slice(0, 7)} (${change.compareStatus}): ${change.commitCount} commits, ${change.filesChanged} files${change.filesTruncated ? " (file list truncated by GitHub)" : ""}.`);

  if (change.pullRequests.length) {
    lines.push("", "## Pull requests in this deployment (newest last)");
    for (const pr of change.pullRequests) {
      lines.push(`### #${pr.number} ${pr.title}`);
      const meta = [`by ${pr.author}`, `+${pr.additions}/-${pr.deletions} in ${pr.filesChanged} files`];
      if (pr.labels.length) meta.push(`labels: ${pr.labels.join(", ")}`);
      if (pr.linkedIssues.length) meta.push(`issues: ${pr.linkedIssues.join(", ")}`);
      lines.push(meta.join(" · "));
      if (pr.body.trim()) lines.push(pr.body.trim().slice(0, 2_500));
      lines.push("");
    }
  } else {
    lines.push("No pull requests were associated with these commits.");
  }

  const files = change.changedFiles ?? [];
  if (files.length) {
    lines.push("## Changed files");
    const byGroup = new Map<string, ChangedFile[]>();
    for (const f of files) {
      const k = fileGroupKey(f.path);
      byGroup.set(k, [...(byGroup.get(k) ?? []), f]);
    }
    for (const [group, list] of byGroup) {
      lines.push(`- ${group}/ (${list.length}): ${list.map((f) => `${f.path.slice(group.length + 1) || f.path} [${f.status[0]}+${f.additions}-${f.deletions}]`).join(", ")}`.slice(0, 600));
    }

    const withPatch = files.filter((f) => f.patch).sort((a, b) => relevanceScore(b, surfaces) - relevanceScore(a, surfaces));
    if (withPatch.length) {
      lines.push("", "## Code diff (most relevant to the surface inventory first)");
      let used = 0;
      let shown = 0;
      for (const f of withPatch) {
        const patch = f.patch as string;
        const body = patch.length > PER_FILE_PATCH_CAP ? `${patch.slice(0, PER_FILE_PATCH_CAP)}\n… [${patch.length - PER_FILE_PATCH_CAP} more chars]` : patch;
        if (used + body.length > patchBudget) break;
        lines.push(`--- ${f.path} (${f.status})`, "```diff", body, "```");
        used += body.length;
        shown += 1;
      }
      if (shown < withPatch.length) {
        lines.push(`(${withPatch.length - shown} more files with patches omitted for length: ${withPatch.slice(shown).map((f) => f.path).join(", ")})`.slice(0, 1_500));
      }
    }
  }
  return lines.join("\n");
}

export function renderProduct(bundle: ContextBundle): string {
  const { product, persona, saturatedSurfaceIds } = bundle;
  const lines: string[] = [];
  lines.push(`Product: ${product.productName}`, `Intent: ${product.intent}`);
  if (product.stakeholders.length) lines.push(`Stakeholders: ${product.stakeholders.join(", ")}`);
  lines.push(`Manifest version: ${product.manifestVersion}`);

  if (product.surfaces.length) {
    lines.push("", "## Surface inventory");
    lines.push("Legend: * = touched by this change (prioritize). ~ = saturated by other agents (skip unless you have a specific reason). F = in your focus.");
    for (const s of product.surfaces) {
      const marks = [s.touchedByChange ? "*" : " ", saturatedSurfaceIds.includes(s.id) ? "~" : " ", persona.focusAreas.includes(s.id) ? "F" : " "].join("");
      lines.push(`${marks} ${s.id} · ${s.kind} · ${s.name} · ${s.locator}${s.description ? ` — ${s.description}` : ""}`);
    }
  } else {
    lines.push("", "## Surface inventory", "The manifest lists no surfaces yet. Discover them yourself starting from the base URL, and use short descriptive slugs (e.g. \"cart-page\", \"checkout-form\") as surfaceId when filing findings or marking visits.");
  }

  if (product.invariants.length) {
    lines.push("", "## Invariants (violations are findings at the listed severity)");
    for (const inv of product.invariants) {
      const where = inv.surfaceIds?.length ? `  (observe on: ${inv.surfaceIds.join(", ")})` : "";
      lines.push(`- ${inv.id} [${inv.severityOnViolation}]: ${inv.statement}${inv.check ? `  (check: ${inv.check})` : ""}${where}`);
    }
  }

  if (product.boundaries?.length) {
    lines.push("", "## Team rules (policy; always follow)");
    for (const b of product.boundaries) lines.push(`- ${b}`);
  }
  return lines.join("\n");
}

export function renderEnvironment(bundle: ContextBundle): string {
  const env = bundle.environment;
  const lines = [
    `Stage: ${env.stageName}`,
    `Base URL: ${env.baseUrl}`,
    `Credentials: ${env.credentialsRef}. If you hit a login wall and no test account was given to you, do NOT guess or invent credentials (never type real-looking emails or passwords); test the login form's validation once, then continue as an anonymous user and list the signed-in flows under done(untested).`,
  ];
  if (env.seededDataRef) lines.push(`Seeded data: ${env.seededDataRef}`);
  if (env.blastRadiusBoundaries.length) {
    lines.push(`NEVER touch (requests are blocked, but do not even try): ${env.blastRadiusBoundaries.join(", ")}`);
  }
  return lines.join("\n");
}

export interface PromptOptions {
  patchBudget?: number;
  /** Team-authored extra instructions appended verbatim. */
  extraInstructions?: string;
}

/** The agent's system prompt: who it is, what changed, what the product is, how to work. */
export function buildSystemPrompt(bundle: ContextBundle, opts: PromptOptions = {}): string {
  const { persona } = bundle;
  const minutes = Math.round(bundle.budgetSeconds / 60);
  const focus = persona.focusAreas.length ? persona.focusAreas.join(", ") : "wherever the change is most likely to have broken something";

  return [
    `# Role`,
    `You are ${persona.name}, one agent in a fleet doing pre-release QA on a deployed preprod environment. ${persona.description}`,
    DISPOSITIONS[persona.disposition],
    `Your focus surfaces: ${focus}. Your run id is ${bundle.runId}; your agent id is ${bundle.agentId}.`,
    ``,
    `# Goal`,
    `Find production-breaking bugs introduced or exposed by this deployment, and report them as structured findings with a short, replayable repro. Exercising a surface with no bug is also valuable: mark it visited so the fleet's coverage is honest.`,
    ``,
    `# How to work`,
    `- Act through tools only. Every result tells you where you are; when unsure, call read_dom.`,
    `- Start by navigating to the base URL (or straight to a focus surface's route). Prefer surfaces marked * (touched by the change) and F (your focus). Skip ~ (saturated) surfaces unless the change makes them suspicious.`,
    `- Use the code diff and PR descriptions to form hypotheses: what did the change touch, what could regress, what edge case did the author probably not test? Test those first.`,
    `- Each tool result may start with "Hard errors since last step": those are free findings. File them immediately with oracle=hard-error unless clearly unrelated to the app (e.g. blocked third-party trackers).`,
    `- When you can compute an invariant (e.g. cart total), call check_invariant with the numbers you saw, whether it holds or not.`,
    `- File a finding the moment you confirm a bug; include exact values/text observed. One finding per distinct bug. Do not file the same symptom twice; do not file speculation you didn't observe.`,
    `- Locators: prefer refs from read_dom (e12) or visible text. If an element isn't found, the failure lists what is on screen; pick from it rather than retrying the same target.`,
    `- If a step fails three times, move on and mention it in done(untested).`,
    `- You have about ${minutes} minute${minutes === 1 ? "" : "s"}. You'll be warned when time is short; then call done with a summary and what you could not test.`,
    ``,
    `# Environment`,
    renderEnvironment(bundle),
    ``,
    `# Product context`,
    renderProduct(bundle),
    ``,
    `# What changed in this deployment`,
    renderChange(bundle.change, bundle.product.surfaces, opts.patchBudget),
    opts.extraInstructions ? `\n# Team instructions\n${opts.extraInstructions}` : "",
  ]
    .join("\n")
    .trim();
}

/** The first user turn that kicks the loop off. */
export function buildKickoff(bundle: ContextBundle): string {
  const touched = bundle.product.surfaces.filter((s) => s.touchedByChange && !bundle.saturatedSurfaceIds.includes(s.id));
  const hint = touched.length
    ? `Surfaces touched by the change and not yet saturated: ${touched.map((s) => `${s.id} (${s.locator})`).join(", ")}.`
    : "No surface is marked as touched; use the PR descriptions and diff to decide where to start.";
  return `Begin. ${hint} Navigate to your first target now.`;
}
