import Link from "next/link";
import { notFound } from "next/navigation";
import { isRunActive } from "@qa-agent/shared-types";
import { getPipeline, getRun, listRuns } from "@/lib/data";
import { AutoRefresh } from "@/components/auto-refresh";
import { SourceColumn, StageColumn, StageConnector } from "@/components/stage-graph";
import {
  Container,
  RunStatusIndicator,
  SeverityCounts,
  StatusIndicator,
  verdictLabel,
  verdictTone,
} from "@/components/ui";
import { duration, relativeTime, shortSha } from "@/lib/format";

export default async function PipelinePage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();

  const stages = [...pipeline.stages].sort((a, b) => a.order - b.order);
  const latestRuns = await Promise.all(stages.map((s) => (s.latestRunId ? getRun(s.latestRunId) : undefined)));
  const recent = (await listRuns(pipeline.id)).slice(0, 6);

  const blocked = latestRuns.filter((r) => r?.verdict === "block").length;

  const active = [...latestRuns, ...recent].some((r) => r !== undefined && isRunActive(r));

  return (
    <div className="space-y-5">
      <AutoRefresh active={active} />
      {blocked > 0 && (
        <div className="flex items-start gap-3 rounded-[8px] border border-[#f0cfcc] bg-error-bg px-4 py-3">
          <StatusIndicator tone="error">Promotion blocked</StatusIndicator>
          <span>
            {blocked} stage{blocked > 1 ? "s have" : " has"} a failing QA gate. Fix or override the P0 findings to let
            the deployment continue to the next stage.
          </span>
        </div>
      )}

      {/* Stage graph */}
      <div className="overflow-x-auto pb-2">
        <div className="flex items-stretch">
          <SourceColumn pipeline={pipeline} />
          {stages.map((stage, i) => (
            <div key={stage.id} className="flex items-stretch">
              <StageConnector />
              <StageColumn pipeline={pipeline} stage={stage} run={latestRuns[i]} nextStage={stages[i + 1]} />
            </div>
          ))}
        </div>
      </div>

      {/* Recent activity */}
      <Container
        title="Recent runs"
        description="Every deployment to a stage branch starts a fleet run. The cursor advances when the run starts."
        padded={false}
        actions={<Link href={`/pipelines/${pipeline.id}/runs`}>View all</Link>}
      >
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Stage</th>
              <th>Status</th>
              <th>Gate</th>
              <th>Change</th>
              <th>Findings</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((run) => {
              const stage = stages.find((s) => s.id === run.stageId);
              return (
                <tr key={run.id}>
                  <td>
                    <Link href={`/pipelines/${pipeline.id}/runs/${run.id}`} className="font-medium">
                      #{run.number}
                    </Link>
                  </td>
                  <td className="capitalize">{stage?.name}</td>
                  <td>
                    <RunStatusIndicator status={run.status} />
                  </td>
                  <td>
                    <StatusIndicator tone={verdictTone(run.verdict)}>{verdictLabel(run.verdict)}</StatusIndicator>
                  </td>
                  <td className="mono">
                    {shortSha(run.change.baseSha)}…{shortSha(run.change.headSha)}
                    <span className="text-text-secondary font-sans text-[13px]">
                      {" "}
                      · {run.change.pullRequests.length} PRs
                    </span>
                  </td>
                  <td>
                    <SeverityCounts counts={run.findings.bySeverity} compact />
                    {run.findings.total === 0 && <span className="text-text-secondary">None</span>}
                  </td>
                  <td className="text-text-secondary">{duration(run.startedAt, run.finishedAt)}</td>
                  <td className="text-text-secondary">{relativeTime(run.startedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Container>
    </div>
  );
}
