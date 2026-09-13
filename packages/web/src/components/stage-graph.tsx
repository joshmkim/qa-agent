import Link from "next/link";
import type { Pipeline, Run, Stage } from "@qa-agent/shared-types";
import {
  Icons,
  Pill,
  ProgressBar,
  RunStatusIndicator,
  SeverityCounts,
  StatusIndicator,
  StepStatusIndicator,
  verdictLabel,
  verdictTone,
} from "@/components/ui";
import { duration, percent, relativeTime, shortSha } from "@/lib/format";

/* ---------- Source column ---------- */

export function SourceColumn({ pipeline }: { pipeline: Pipeline }) {
  const repo = pipeline.repository;
  return (
    <div className="awsui-container flex w-[260px] shrink-0 flex-col">
      <div className="awsui-container-header">
        <div className="text-text-secondary text-[12px] font-bold uppercase tracking-wide">Source</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[16px] font-bold">
          <Icons.github />
          {repo.name}
        </div>
      </div>
      <div className="space-y-3 p-4 text-[13px]">
        <StepRow title="GitHub App" status={<StatusIndicator tone="success">Connected</StatusIndicator>}>
          Installation <span className="mono">{repo.installationId}</span>
        </StepRow>
        <StepRow title="Webhooks" status={<StatusIndicator tone="success">Receiving</StatusIndicator>}>
          push · pull_request · check_run
        </StepRow>
        <StepRow title="Default branch" status={<Pill>{repo.defaultBranch}</Pill>}>
          Stage branches: {pipeline.stages.map((s) => s.branch).join(", ")}
        </StepRow>
      </div>
    </div>
  );
}

/* ---------- Stage column ---------- */

export function StageColumn({
  pipeline,
  stage,
  run,
  nextStage,
}: {
  pipeline: Pipeline;
  stage: Stage;
  run?: Run;
  nextStage?: Stage;
}) {
  const runHref = run ? `/pipelines/${pipeline.id}/runs/${run.id}` : undefined;
  const changedPct = run
    ? percent(run.coverage.changedSurfacesVisited, run.coverage.changedSurfacesTotal)
    : 0;
  const isTerminal = run && (run.status === "passed" || run.status === "blocked");

  return (
    <div className="awsui-container flex w-[360px] shrink-0 flex-col">
      <div className="awsui-container-header">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-text-secondary text-[12px] font-bold uppercase tracking-wide">
              Stage {stage.order}
            </div>
            <div className="mt-0.5 text-[18px] font-bold capitalize leading-6">{stage.name}</div>
          </div>
          {run && <RunStatusIndicator status={run.status} />}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]">
          <Pill>branch: {stage.branch}</Pill>
          {stage.environmentUrl && (
            <a href={stage.environmentUrl} className="inline-flex items-center gap-1" target="_blank" rel="noreferrer">
              {stage.environmentUrl.replace(/^https?:\/\//, "")}
              <Icons.external />
            </a>
          )}
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4 text-[13px]">
        {/* 1. Deployment detected */}
        <StepRow
          title="Deployment"
          status={<StepStatusIndicator status={run ? "succeeded" : "pending"} />}
        >
          {stage.cursor ? (
            <>
              <span className="mono">{shortSha(stage.cursor.sha)}</span>
              {stage.cursor.prNumber && (
                <>
                  {" "}
                  · <a href={`${pipeline.repository.url}/pull/${stage.cursor.prNumber}`}>#{stage.cursor.prNumber}</a>
                </>
              )}
              <span className="text-text-secondary"> · {relativeTime(stage.cursor.updatedAt)}</span>
              {run && (
                <div className="text-text-secondary mt-0.5">
                  {run.change.commitCount} commits, {run.change.pullRequests.length} PRs since last cursor
                </div>
              )}
            </>
          ) : (
            <span className="text-text-secondary">Waiting for first deployment</span>
          )}
        </StepRow>

        {/* 2. Agentic QA */}
        <StepRow
          title={
            run ? (
              <Link href={runHref!} className="font-bold">
                Agentic QA · Run #{run.number}
              </Link>
            ) : (
              "Agentic QA"
            )
          }
          status={
            run ? (
              isTerminal ? (
                <StatusIndicator tone="success">Completed</StatusIndicator>
              ) : (
                <StepStatusIndicator status="running" />
              )
            ) : (
              <StepStatusIndicator status="pending" />
            )
          }
          emphasized
        >
          {run ? (
            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5">
                  <Icons.agent />
                  {run.fleet.agentsCompleted}/{run.fleet.agentsRequested} agents
                  {run.fleet.agentsFailed > 0 && (
                    <span className="text-text-secondary">({run.fleet.agentsFailed} failed)</span>
                  )}
                </span>
                <span className="text-text-secondary">{duration(run.startedAt, run.finishedAt)}</span>
              </div>
              <ProgressBar
                value={changedPct}
                tone={changedPct === 100 ? "success" : changedPct >= 80 ? "info" : "warning"}
                label={
                  <>
                    <span>Changed surfaces covered</span>
                    <span className="font-bold text-text">
                      {run.coverage.changedSurfacesVisited}/{run.coverage.changedSurfacesTotal} ({changedPct}%)
                    </span>
                  </>
                }
              />
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">Findings</span>
                <SeverityCounts counts={run.findings.bySeverity} />
              </div>
            </div>
          ) : (
            <span className="text-text-secondary">Fleet of {stage.fleetSize} agents will run on next deployment</span>
          )}
        </StepRow>

        {/* 3. Promotion gate */}
        {stage.gatesPromotion ? (
          <StepRow
            title={
              <>
                Promotion gate <span className="text-text-secondary">→ {nextStage?.name ?? stage.protectedBranch}</span>
              </>
            }
            status={
              run ? (
                <StatusIndicator tone={verdictTone(run.verdict)}>{verdictLabel(run.verdict)}</StatusIndicator>
              ) : (
                <StepStatusIndicator status="pending" />
              )
            }
          >
            <div className="text-text-secondary">
              Check run <span className="mono">agentic-qa/{stage.name}</span> on protected branch{" "}
              <span className="mono">{stage.protectedBranch}</span>
              {run?.checkRunId && (
                <>
                  {" "}
                  ·{" "}
                  <a href={`${pipeline.repository.url}/runs/${run.checkRunId}`} target="_blank" rel="noreferrer">
                    view on GitHub
                  </a>
                </>
              )}
            </div>
          </StepRow>
        ) : (
          <StepRow title="Promotion gate" status={<StatusIndicator tone="stopped">Not gating</StatusIndicator>}>
            <span className="text-text-secondary">Monitoring only. Findings are reported, promotion is not blocked.</span>
          </StepRow>
        )}
      </div>

      {run?.confidenceStatement && (
        <div className="border-t border-border bg-[#fafafa] px-4 py-3 text-[13px]">
          <div className="text-text-secondary mb-1 flex items-center justify-between text-[12px] font-bold uppercase tracking-wide">
            <span>Confidence</span>
            <span className="text-text text-[13px] normal-case tracking-normal">
              {Math.round((run.confidenceScore ?? 0) * 100)}%
            </span>
          </div>
          <p className="line-clamp-3">{run.confidenceStatement}</p>
          <Link href={runHref!} className="mt-1 inline-flex items-center gap-0.5 font-bold">
            View run <Icons.chevronRight />
          </Link>
        </div>
      )}
    </div>
  );
}

/* ---------- Step row ---------- */

function StepRow({
  title,
  status,
  children,
  emphasized = false,
}: {
  title: React.ReactNode;
  status: React.ReactNode;
  children: React.ReactNode;
  emphasized?: boolean;
}) {
  return (
    <div
      className={`rounded-[8px] border p-3 ${
        emphasized ? "border-[#b5d6f4] bg-info-bg/40" : "border-border bg-white"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="font-bold">{title}</div>
        <div className="shrink-0 text-[12px]">{status}</div>
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

export function StageConnector() {
  return <div className="stage-connector" aria-hidden="true" />;
}
