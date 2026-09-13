import { isRunActive } from "@qa-agent/shared-types";
import type { Pipeline } from "@qa-agent/shared-types";
import { getRun } from "@/lib/data";
import { AutoRefresh } from "@/components/auto-refresh";
import { SourceColumn, StageColumn, StageConnector } from "@/components/stage-graph";
import { StatusIndicator } from "@/components/ui";

/**
 * The stage graph dashboard for a single pipeline. Shared by the pipeline
 * detail route and the homepage (which renders it for the primary pipeline
 * directly, matching the Claude Design pipeline canvas).
 */
export async function PipelineOverview({ pipeline }: { pipeline: Pipeline }) {
  const stages = [...pipeline.stages].sort((a, b) => a.order - b.order);
  const latestRuns = await Promise.all(stages.map((s) => (s.latestRunId ? getRun(s.latestRunId) : undefined)));

  const blocked = latestRuns.filter((r) => r?.verdict === "block").length;

  const active = latestRuns.some((r) => r !== undefined && isRunActive(r));

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
        <div className="flex items-start">
          <SourceColumn pipeline={pipeline} />
          {stages.map((stage, i) => (
            <div key={stage.id} className="flex items-stretch">
              <StageConnector />
              <StageColumn pipeline={pipeline} stage={stage} run={latestRuns[i]} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
