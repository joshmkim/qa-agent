import Link from "next/link";
import { notFound } from "next/navigation";
import type { ActionStep, Evidence } from "@qa-agent/shared-types";
import { getFinding, getPipeline, getRun, getRunManifest } from "@/lib/data";
import { FindingStatusIndicator, oracleLabel } from "@/components/findings-table";
import {
  Button,
  Code,
  Container,
  Icons,
  KeyValue,
  KeyValueGrid,
  Pill,
  SeverityBadge,
  StatusIndicator,
} from "@/components/ui";
import { formatDateTime } from "@/lib/format";

export default async function FindingPage({
  params,
}: {
  params: Promise<{ pipelineId: string; runId: string; findingId: string }>;
}) {
  const { pipelineId, runId, findingId } = await params;
  const [pipeline, run, finding] = await Promise.all([getPipeline(pipelineId), getRun(runId), getFinding(findingId)]);
  if (!pipeline || !run || !finding || finding.runId !== run.id) notFound();
  // Look up against the manifest this run used, not whatever is on the branch now.
  const product = (await getRunManifest(run.id))?.product;
  const surface = product?.surfaces.find((s) => s.id === finding.surfaceId);
  const invariant = finding.invariantId ? product?.invariants.find((i) => i.id === finding.invariantId) : undefined;

  const suspectPr = finding.triage?.suspectedPrNumber
    ? run.change.pullRequests.find((p) => p.number === finding.triage?.suspectedPrNumber)
    : undefined;

  return (
    <div className="space-y-5">
      {/* Sub header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-[1000px]">
          <div className="text-text-secondary text-[13px]">
            <Link href={`/pipelines/${pipeline.id}/runs`}>Runs</Link> /{" "}
            <Link href={`/pipelines/${pipeline.id}/runs/${run.id}`}>Run #{run.number}</Link> /{" "}
            <span className="mono">{finding.id}</span>
          </div>
          <h2 className="mt-1 flex items-start gap-3 text-[22px] font-medium leading-7">
            <span className="mt-1">
              <SeverityBadge severity={finding.severity} />
            </span>
            {finding.title}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <FindingStatusIndicator status={finding.status} />
            <span className="text-text-secondary">·</span>
            <Pill tone={finding.oracle === "hard-error" ? "error" : finding.oracle === "invariant" ? "warning" : "info"}>
              {oracleLabel(finding.oracle)}
            </Pill>
            <span className="text-text-secondary">·</span>
            <span className="inline-flex items-center gap-1.5 text-text-secondary">
              <Icons.agent />
              {finding.personaName} <span className="mono">({finding.agentId})</span>
            </span>
            <span className="text-text-secondary">·</span>
            <span className="text-text-secondary">Reported {formatDateTime(finding.reportedAt)}</span>
            {finding.trackedIssue && (
              <>
                <span className="text-text-secondary">·</span>
                <a href={finding.trackedIssue.url} target="_blank" rel="noreferrer" className="mono">
                  {finding.trackedIssue.key}
                </a>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button disabled title="Coming soon">
            Dismiss
          </Button>
          <Button disabled title="Coming soon">
            Emit regression test
          </Button>
          <Button variant="primary" disabled title="Coming soon">
            Replay repro
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        {/* Left: summary + repro */}
        <div className="space-y-5 xl:col-span-2">
          <Container title="Summary">
            <p className="text-[15px] leading-6">{finding.summary}</p>
            {invariant && (
              <div className="mt-4 rounded-[8px] border border-[#e8d6b0] bg-warning-bg p-3">
                <div className="text-warning text-[12px] font-medium uppercase tracking-wide">Invariant violated</div>
                <div className="mt-1 font-medium">{invariant.statement}</div>
                {invariant.check && (
                  <div className="mt-1">
                    <Code>{invariant.check}</Code>
                  </div>
                )}
                <div className="text-text-secondary mt-1 text-[12px]">
                  <span className="mono">{invariant.id}</span> · default severity {invariant.severityOnViolation}
                </div>
              </div>
            )}
          </Container>

          <Container
            title={`Reproduction steps (${finding.reproSteps.length})`}
            description="The agent's action trace, replayable from a clean session with the same seeded data."
            padded={false}
          >
            <ol className="divide-y divide-border">
              {finding.reproSteps.map((s) => (
                <ActionStepRow key={s.index} step={s} />
              ))}
            </ol>
          </Container>
        </div>

        {/* Right: details + triage + evidence */}
        <div className="space-y-5">
          <Container title="Details">
            <KeyValueGrid columns={2}>
              <KeyValue label="Surface">
                {surface ? (
                  <>
                    <div className="font-medium">{surface.name}</div>
                    <div className="text-text-secondary text-[12px]">
                      {surface.kind} · <span className="mono">{surface.locator}</span>
                    </div>
                    {surface.touchedByChange && (
                      <div className="mt-1">
                        <Pill tone="info">Touched by change</Pill>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="mono">{finding.surfaceId}</span>
                )}
              </KeyValue>
              <KeyValue label="Stage">
                <span className="capitalize">{pipeline.stages.find((s) => s.id === run.stageId)?.name}</span>
              </KeyValue>
              <KeyValue label="Dedupe key">
                <span className="mono break-all">{finding.dedupeKey}</span>
              </KeyValue>
              <KeyValue label="Duplicate reports">
                <span className="font-medium">{finding.triage?.duplicateCount ?? 0}</span> other agents
              </KeyValue>
            </KeyValueGrid>
          </Container>

          <Container title="Triage">
            {finding.triage ? (
              <div className="space-y-3">
                <div>
                  {finding.triage.reproducedFromCleanSession ? (
                    <StatusIndicator tone="success">Reproduced from clean session</StatusIndicator>
                  ) : (
                    <StatusIndicator tone="warning">Not reproduced from clean session</StatusIndicator>
                  )}
                </div>
                {finding.triage.duplicateOf && (
                  <div className="text-[13px]">
                    Duplicate of <span className="mono">{finding.triage.duplicateOf}</span>
                  </div>
                )}
                {finding.triage.suspectedPrNumber && (
                  <KeyValue label="Suspected PR">
                    {suspectPr ? (
                      <a href={suspectPr.url} target="_blank" rel="noreferrer">
                        <span className="mono">#{suspectPr.number}</span> {suspectPr.title}
                      </a>
                    ) : (
                      <span className="mono">#{finding.triage.suspectedPrNumber}</span>
                    )}
                  </KeyValue>
                )}
                {finding.triage.note && (
                  <KeyValue label="Judge note">
                    <p className="text-[13px] leading-5">{finding.triage.note}</p>
                  </KeyValue>
                )}
              </div>
            ) : (
              <span className="text-text-secondary">Awaiting triage.</span>
            )}
          </Container>

          <Container title={`Evidence (${finding.evidence.length})`} padded={false}>
            {finding.evidence.length === 0 ? (
              <div className="text-text-secondary px-5 py-6 text-center">No evidence attached.</div>
            ) : (
              <ul className="divide-y divide-border">
                {finding.evidence.map((e) => (
                  <EvidenceRow key={e.id} evidence={e} />
                ))}
              </ul>
            )}
          </Container>
        </div>
      </div>
    </div>
  );
}

function ActionStepRow({ step }: { step: ActionStep }) {
  const tone = step.outcome === "ok" ? "success" : step.outcome === "recovered" ? "warning" : "error";
  const argEntries = Object.entries(step.args);
  return (
    <li className="flex gap-4 px-5 py-3">
      <div className="text-text-secondary w-6 shrink-0 pt-0.5 text-right text-[13px] font-medium">{step.index}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone="neutral">{step.kind}</Pill>
          <span className="font-medium">{step.description}</span>
        </div>
        {argEntries.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1.5">
            {argEntries.map(([k, v]) => (
              <Code key={k}>
                {k}={String(v)}
              </Code>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right text-[12px]">
        <StatusIndicator tone={tone}>{step.outcome}</StatusIndicator>
        <div className="text-text-secondary mt-0.5">{step.durationMs} ms</div>
        {step.screenshotId && <div className="text-text-secondary mono">{step.screenshotId}</div>}
      </div>
    </li>
  );
}

function EvidenceRow({ evidence }: { evidence: Evidence }) {
  const kindTone = evidence.kind === "screenshot" ? "info" : evidence.kind === "log" ? "neutral" : "warning";
  return (
    <li className="px-5 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Pill tone={kindTone}>{evidence.kind}</Pill>
          <span className="font-medium text-[13px]">{evidence.label}</span>
        </div>
        <span className="text-text-secondary whitespace-nowrap text-[12px]">{formatDateTime(evidence.capturedAt)}</span>
      </div>
      {evidence.kind === "screenshot" ? (
        <div className="mt-2 flex h-[140px] items-center justify-center rounded-[8px] border border-dashed border-border-strong bg-[#f7f7f5] text-text-secondary text-[12px]">
          Screenshot placeholder · <span className="mono ml-1">{evidence.content}</span>
        </div>
      ) : (
        <pre className="mono mt-2 overflow-x-auto whitespace-pre-wrap rounded-[8px] border border-border bg-[#f7f7f5] p-3 text-[12px] leading-[18px]">
          {evidence.content}
        </pre>
      )}
    </li>
  );
}
