import Link from "next/link";
import { notFound } from "next/navigation";
import { isRunActive } from "@qa-agent/shared-types";
import { getPipeline, listRuns } from "@/lib/data";
import { AutoRefresh } from "@/components/auto-refresh";
import {
  Container,
  RunStatusIndicator,
  SeverityCounts,
  StatusIndicator,
  verdictLabel,
  verdictTone,
} from "@/components/ui";
import { duration, formatDateTime, percent, shortSha } from "@/lib/format";

export default async function RunsPage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();
  const runs = await listRuns(pipeline.id);

  return (
    <>
      <AutoRefresh active={runs.some(isRunActive)} />
      <Container title={`Runs (${runs.length})`} description="All fleet runs across every stage, newest first." padded={false}>
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Gate</th>
              <th>Confidence</th>
              <th>Coverage</th>
              <th>Findings</th>
              <th>Trigger</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const stage = pipeline.stages.find((s) => s.id === run.stageId);
              return (
                <tr key={run.id}>
                  <td>
                    <Link href={`/pipelines/${pipeline.id}/runs/${run.id}`} className="font-bold">
                      #{run.number}
                    </Link>
                    <div className="mono text-text-secondary mt-0.5">{shortSha(run.change.headSha)}</div>
                  </td>
                  <td className="capitalize">{stage?.name}</td>
                  <td>
                    <RunStatusIndicator status={run.status} />
                  </td>
                  <td>
                    <StatusIndicator tone={verdictTone(run.verdict)}>{verdictLabel(run.verdict)}</StatusIndicator>
                  </td>
                  <td className="font-bold">{Math.round((run.confidenceScore ?? 0) * 100)}%</td>
                  <td>{percent(run.coverage.changedSurfacesVisited, run.coverage.changedSurfacesTotal)}% changed</td>
                  <td>
                    {run.findings.total === 0 ? (
                      <span className="text-text-secondary">None</span>
                    ) : (
                      <SeverityCounts counts={run.findings.bySeverity} compact />
                    )}
                  </td>
                  <td className="text-text-secondary">
                    {run.trigger}
                    {run.triggeredBy && <div className="mono">{run.triggeredBy}</div>}
                  </td>
                  <td className="text-text-secondary">{duration(run.startedAt, run.finishedAt)}</td>
                  <td className="text-text-secondary whitespace-nowrap">{formatDateTime(run.startedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Container>
    </>
  );
}
