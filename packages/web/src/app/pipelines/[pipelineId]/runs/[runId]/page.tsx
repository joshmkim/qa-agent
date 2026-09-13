import Link from "next/link";
import { notFound } from "next/navigation";
import { getPipeline, getRun, getStage, listFindings } from "@/lib/data";
import { FindingsTable } from "@/components/findings-table";
import {
  Button,
  Container,
  Icons,
  KeyValue,
  KeyValueGrid,
  Pill,
  ProgressBar,
  RunStatusIndicator,
  SeverityCounts,
  StatusIndicator,
  StepStatusIndicator,
  verdictLabel,
  verdictTone,
} from "@/components/ui";
import { compact, duration, formatDateTime, percent, shortSha } from "@/lib/format";

export default async function RunPage({ params }: { params: Promise<{ pipelineId: string; runId: string }> }) {
  const { pipelineId, runId } = await params;
  const [pipeline, run] = await Promise.all([getPipeline(pipelineId), getRun(runId)]);
  if (!pipeline || !run || run.repositoryId !== pipeline.repository.id) notFound();
  const [stage, findings] = await Promise.all([getStage(run.stageId), listFindings(run.id)]);

  const changedPct = percent(run.coverage.changedSurfacesVisited, run.coverage.changedSurfacesTotal);
  const allPct = percent(run.coverage.surfacesVisited, run.coverage.surfacesTotal);
  const invPct = percent(run.coverage.invariantsChecked, run.coverage.invariantsTotal);
  const tone = verdictTone(run.verdict);
  const bannerCls =
    tone === "error"
      ? "border-[#f5b0b0] bg-error-bg"
      : tone === "success"
        ? "border-[#a6dfab] bg-success-bg"
        : tone === "warning"
          ? "border-[#f0dc8a] bg-warning-bg"
          : "border-border bg-white";

  return (
    <div className="space-y-5">
      {/* Sub header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-text-secondary text-[13px]">
            <Link href={`/pipelines/${pipeline.id}/runs`}>Runs</Link> / <span className="capitalize">{stage?.name}</span>
          </div>
          <h2 className="mt-1 flex items-center gap-3 text-[22px] font-bold leading-7">
            Run #{run.number}
            <RunStatusIndicator status={run.status} />
          </h2>
          <div className="text-text-secondary mt-1 flex flex-wrap items-center gap-2 text-[13px]">
            <span>Started {formatDateTime(run.startedAt)}</span>
            <span>·</span>
            <span>{duration(run.startedAt, run.finishedAt)}</span>
            <span>·</span>
            <span>
              Trigger: {run.trigger}
              {run.triggeredBy && <span className="mono"> ({run.triggeredBy})</span>}
            </span>
            {run.checkRunId && (
              <>
                <span>·</span>
                <a
                  href={`${pipeline.repository.url}/runs/${run.checkRunId}`}
                  className="inline-flex items-center gap-1"
                  target="_blank"
                  rel="noreferrer"
                >
                  Check run <Icons.external />
                </a>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button disabled title="Coming soon">
            Ask the fleet
          </Button>
          <Button disabled title="Coming soon">
            Re-run
          </Button>
          {run.verdict === "block" && (
            <Button variant="primary" disabled title="Coming soon">
              Override gate
            </Button>
          )}
        </div>
      </div>

      {/* Verdict banner */}
      <div className={`rounded-[16px] border p-5 ${bannerCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-[900px]">
            <div className="text-[16px]">
              <StatusIndicator tone={tone}>{verdictLabel(run.verdict)}</StatusIndicator>
              {stage?.gatesPromotion && stage.protectedBranch && (
                <span className="text-text-secondary ml-2 text-[13px]">
                  gating <span className="mono">{stage.branch}</span> → <span className="mono">{stage.protectedBranch}</span>
                </span>
              )}
            </div>
            <p className="mt-2 text-[16px] leading-6">{run.confidenceStatement}</p>
          </div>
          <div className="text-right">
            <div className="text-text-secondary text-[12px] font-bold uppercase tracking-wide">Confidence</div>
            <div className="text-[40px] font-bold leading-[44px]">{Math.round((run.confidenceScore ?? 0) * 100)}%</div>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-4">
        <Container title="Coverage">
          <div className="space-y-3">
            <ProgressBar
              value={changedPct}
              tone={changedPct === 100 ? "success" : changedPct >= 80 ? "info" : "warning"}
              label={
                <>
                  <span>Changed surfaces</span>
                  <span className="text-text font-bold">
                    {run.coverage.changedSurfacesVisited}/{run.coverage.changedSurfacesTotal}
                  </span>
                </>
              }
            />
            <ProgressBar
              value={allPct}
              label={
                <>
                  <span>All surfaces</span>
                  <span className="text-text font-bold">
                    {run.coverage.surfacesVisited}/{run.coverage.surfacesTotal}
                  </span>
                </>
              }
            />
            <ProgressBar
              value={invPct}
              tone={invPct === 100 ? "success" : "info"}
              label={
                <>
                  <span>Invariants checked</span>
                  <span className="text-text font-bold">
                    {run.coverage.invariantsChecked}/{run.coverage.invariantsTotal}
                  </span>
                </>
              }
            />
          </div>
        </Container>

        <Container title="Fleet">
          <KeyValueGrid columns={2}>
            <KeyValue label="Agents">
              <span className="text-[20px] font-bold">{run.fleet.agentsCompleted}</span>
              <span className="text-text-secondary"> / {run.fleet.agentsRequested}</span>
            </KeyValue>
            <KeyValue label="Actions taken">
              <span className="text-[20px] font-bold">{compact(run.fleet.totalActions)}</span>
            </KeyValue>
          </KeyValueGrid>
          <div className="mt-3">
            <div className="text-text-secondary mb-1 text-[12px]">Dispositions</div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-[#e9ebed]">
              {Object.entries(run.fleet.dispositions).map(([k, v], i) => (
                <div
                  key={k}
                  title={`${k}: ${v}`}
                  className={["bg-info", "bg-[#7d2105]", "bg-[#8d6605]", "bg-[#3b8b7e]"][i % 4]}
                  style={{ width: `${(v / run.fleet.agentsRequested) * 100}%` }}
                />
              ))}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-text-secondary">
              {Object.entries(run.fleet.dispositions).map(([k, v]) => (
                <span key={k}>
                  {k} <span className="text-text font-bold">{v}</span>
                </span>
              ))}
            </div>
          </div>
        </Container>

        <Container title="Findings">
          <div className="text-[20px] font-bold">
            {run.findings.total}
            <span className="text-text-secondary text-[14px] font-normal"> unique</span>
          </div>
          <div className="mt-2">
            <SeverityCounts counts={run.findings.bySeverity} />
          </div>
          <div className="text-text-secondary mt-3 text-[13px]">
            {run.findings.duplicatesCollapsed} duplicate reports collapsed by triage
          </div>
        </Container>

        <Container title="Change">
          <KeyValueGrid columns={2}>
            <KeyValue label="Commits">
              <span className="text-[20px] font-bold">{run.change.commitCount}</span>
            </KeyValue>
            <KeyValue label="Files">
              <span className="text-[20px] font-bold">{run.change.filesChanged}</span>
            </KeyValue>
          </KeyValueGrid>
          <div className="mono mt-3">
            {shortSha(run.change.baseSha)} … {shortSha(run.change.headSha)}
          </div>
          <div className="text-text-secondary mt-1 text-[13px]">
            {run.change.pullRequests.length} pull requests · compare status: {run.change.compareStatus}
          </div>
        </Container>
      </div>

      {/* Steps */}
      <Container title="Steps" padded={false}>
        <ol className="flex flex-wrap divide-x divide-border">
          {run.steps.map((step) => (
            <li key={step.id} className="min-w-[200px] flex-1 px-5 py-4">
              <div className="text-[12px]">
                <StepStatusIndicator status={step.status} />
              </div>
              <div className="mt-1 font-bold">{step.name}</div>
              <div className="text-text-secondary mt-0.5 text-[12px]">
                {step.startedAt && step.finishedAt ? duration(step.startedAt, step.finishedAt) : "—"}
                {step.detail && <> · {step.detail}</>}
              </div>
            </li>
          ))}
        </ol>
      </Container>

      {/* Findings */}
      <Container
        title={`Findings (${findings.length})`}
        description="Ranked by severity. Each finding is a runnable repro: the action trace can be replayed from a clean session."
        padded={false}
      >
        <FindingsTable pipelineId={pipeline.id} findings={findings} />
      </Container>

      {/* Change context */}
      <Container
        title={`Pull requests in this change (${run.change.pullRequests.length})`}
        description="PR titles and bodies are fed to the fleet as product context for what changed and why."
        padded={false}
      >
        {run.change.pullRequests.length === 0 ? (
          <div className="text-text-secondary px-5 py-8 text-center">
            No pull requests found in this range; commits were pushed directly.
          </div>
        ) : (
          <table className="awsui-table">
            <thead>
              <tr>
                <th>PR</th>
                <th>Title</th>
                <th>Author</th>
                <th>Labels</th>
                <th>Size</th>
                <th>Merged</th>
              </tr>
            </thead>
            <tbody>
              {run.change.pullRequests.map((pr) => (
                <tr key={pr.number}>
                  <td>
                    <a href={pr.url} className="mono font-bold" target="_blank" rel="noreferrer">
                      #{pr.number}
                    </a>
                  </td>
                  <td className="max-w-[520px]">
                    <div className="font-bold">{pr.title}</div>
                    <div className="text-text-secondary mt-0.5 line-clamp-2 text-[13px]">{pr.body}</div>
                    {pr.linkedIssues.length > 0 && (
                      <div className="text-text-secondary mt-0.5 text-[12px]">Closes {pr.linkedIssues.join(", ")}</div>
                    )}
                  </td>
                  <td>{pr.author}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {pr.labels.map((l) => (
                        <Pill key={l}>{l}</Pill>
                      ))}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-[13px]">
                    {pr.filesChanged} files ·{" "}
                    <span className="text-success">+{pr.additions}</span>{" "}
                    <span className="text-error">−{pr.deletions}</span>
                  </td>
                  <td className="text-text-secondary whitespace-nowrap">{formatDateTime(pr.mergedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Container>
    </div>
  );
}
