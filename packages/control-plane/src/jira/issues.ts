import type { Finding, Repository, Run, Stage } from "@qa-agent/shared-types";
import type { JiraConfig } from "../config";
import type { AdfNode } from "./client";
import { issueUrl } from "./keys";

/** Jira rejects summaries over 255 characters. */
const MAX_SUMMARY = 255;
const MAX_REPRO_STEPS = 25;
const MAX_EVIDENCE = 5;
const MAX_EVIDENCE_CHARS = 600;

// --- ADF builders (Jira Cloud REST v3 takes rich text as a document tree) ---

const text = (value: string): AdfNode => ({ type: "text", text: value });

const linkText = (value: string, href: string): AdfNode => ({
  type: "text",
  text: value,
  marks: [{ type: "link", attrs: { href } }],
});

const paragraph = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

const heading = (value: string): AdfNode => ({
  type: "heading",
  attrs: { level: 3 },
  content: [text(value)],
});

const codeBlock = (value: string): AdfNode => ({
  type: "codeBlock",
  attrs: {},
  content: [text(value)],
});

function list(type: "bulletList" | "orderedList", items: AdfNode[][]): AdfNode {
  return {
    type,
    content: items.map((content) => ({ type: "listItem", content: [paragraph(...content)] })),
  };
}

export const doc = (...content: AdfNode[]): AdfNode => ({ type: "doc", version: 1, content });

/**
 * Label that ties a Jira issue to a finding's dedupe key, so a re-run or a
 * later deployment that reproduces the same defect updates the existing
 * issue instead of filing a second one. Survives a control-plane restart
 * because the state lives in Jira, not in the in-memory store.
 */
export function dedupeLabel(finding: Finding): string {
  const safe = finding.dedupeKey.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return `qafleet-${safe}`;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

const ORACLE_LABEL: Record<Finding["oracle"], string> = {
  "hard-error": "Hard error (5xx, uncaught exception, or crash)",
  invariant: "Team invariant violated",
  "llm-judgment": "Judged against the product description",
};

function reproSection(finding: Finding): AdfNode[] {
  if (finding.reproSteps.length === 0) return [];
  const steps = finding.reproSteps.slice(0, MAX_REPRO_STEPS).map((step) => {
    const outcome = step.outcome === "ok" ? "" : ` — ${step.outcome}`;
    return [text(`${step.kind}: ${step.description}${outcome}`)];
  });
  const nodes = [heading("Steps to reproduce"), list("orderedList", steps)];
  const rest = finding.reproSteps.length - MAX_REPRO_STEPS;
  if (rest > 0) nodes.push(paragraph(text(`…and ${rest} more steps in the full trace.`)));
  return nodes;
}

function evidenceSection(finding: Finding): AdfNode[] {
  if (finding.evidence.length === 0) return [];
  const nodes: AdfNode[] = [heading("Evidence")];
  for (const item of finding.evidence.slice(0, MAX_EVIDENCE)) {
    if (item.kind === "screenshot") {
      nodes.push(paragraph(text(`${item.label}: `), linkText("screenshot", item.content)));
    } else {
      nodes.push(paragraph(text(`${item.label} (${item.kind}):`)));
      nodes.push(codeBlock(truncate(item.content, MAX_EVIDENCE_CHARS)));
    }
  }
  const rest = finding.evidence.length - MAX_EVIDENCE;
  if (rest > 0) nodes.push(paragraph(text(`…and ${rest} more evidence items on the finding page.`)));
  return nodes;
}

function contextSection(input: {
  finding: Finding;
  repository: Repository;
  stage: Stage;
  run: Run;
  config: JiraConfig;
}): AdfNode[] {
  const { finding, repository, stage, run, config } = input;
  const items: AdfNode[][] = [
    [text(`Severity ${finding.severity} · ${ORACLE_LABEL[finding.oracle]}`)],
    [text(`Surface: ${finding.surfaceId}`)],
    [text(`Stage: ${stage.name} (${stage.branch}) on ${repository.fullName}`)],
    [
      text("Commit under test: "),
      linkText(run.change.headSha.slice(0, 7), `${repository.url}/commit/${run.change.headSha}`),
    ],
    [text(`Found by agent ${finding.agentId} playing "${finding.personaName}"`)],
  ];

  if (finding.invariantId) {
    items.push([text(`Invariant violated: ${finding.invariantId}`)]);
  }

  const suspected = finding.triage?.suspectedPrNumber;
  if (suspected !== undefined) {
    items.push([
      text("Suspected cause: "),
      linkText(`#${suspected}`, `${repository.url}/pull/${suspected}`),
    ]);
  }

  const tickets = run.change.jiraKeys ?? [];
  if (tickets.length > 0) {
    const content: AdfNode[] = [text("Tickets in this deployment: ")];
    tickets.forEach((key, i) => {
      if (i > 0) content.push(text(", "));
      content.push(linkText(key, issueUrl(config.baseUrl, key)));
    });
    items.push(content);
  }

  if (finding.triage?.duplicateCount) {
    items.push([text(`Seen ${finding.triage.duplicateCount + 1} times across the fleet in this run.`)]);
  }

  return [heading("Context"), list("bulletList", items)];
}

/** Fields for `POST /rest/api/3/issue`. */
export function issueFields(input: {
  finding: Finding;
  repository: Repository;
  stage: Stage;
  run: Run;
  findingUrl: string;
  runUrl: string;
  config: JiraConfig;
}): Record<string, unknown> {
  const { finding, repository, stage, run, findingUrl, runUrl, config } = input;

  const description = doc(
    paragraph(text(finding.summary)),
    ...contextSection({ finding, repository, stage, run, config }),
    ...reproSection(finding),
    ...evidenceSection(finding),
    heading("Links"),
    list("bulletList", [
      [linkText("Finding detail and replayable trace", findingUrl)],
      [linkText(`QA run #${run.number}`, runUrl)],
    ]),
    paragraph(text("Filed automatically by the Agentic QA Fleet. Re-runs update this issue rather than filing a new one.")),
  );

  return {
    project: { key: config.projectKey },
    issuetype: { name: config.issueType },
    summary: truncate(`[${finding.severity}] ${finding.title}`, MAX_SUMMARY),
    description,
    // Severity travels as a label because Priority is not on every free-plan
    // project's create screen, and an unknown field id fails the whole create.
    labels: ["qa-fleet", `qa-${finding.severity}`, `qa-${stage.name}`, dedupeLabel(finding)],
  };
}

/** Comment posted when an already-filed finding shows up in a later run. */
export function recurrenceComment(input: { run: Run; runUrl: string; findingUrl: string }): AdfNode {
  const { run, runUrl, findingUrl } = input;
  return doc(
    paragraph(
      text("Still reproducing in "),
      linkText(`QA run #${run.number}`, runUrl),
      text(` at commit ${run.change.headSha.slice(0, 7)}. `),
      linkText("Latest finding detail", findingUrl),
    ),
  );
}
