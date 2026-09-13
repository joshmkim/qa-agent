import Link from "next/link";
import type { Pipeline, Run, Stage } from "@qa-agent/shared-types";
import { listFindings } from "@/lib/data";
import {
  Icons,
  Pill,
  RunStatusIndicator,
  SeverityBadge,
  SeverityCounts,
  StatusIndicator,
  verdictTone,
} from "@/components/ui";
import { shortSha } from "@/lib/format";

/* ---------- Source column ---------- */

export function SourceColumn({ pipeline }: { pipeline: Pipeline }) {
  const repo = pipeline.repository;
  return (
    <div className="awsui-container flex w-[216px] shrink-0 flex-col">
      <div className="awsui-container-header">
        <div className="text-text-secondary text-[12px] font-medium uppercase tracking-wide">Source</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[16px] font-medium">
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

const CONFIDENCE_TEXT_TONE: Record<string, string> = {
  success: "text-success",
  error: "text-error",
  warning: "text-warning",
  info: "text-info",
  pending: "text-pending",
  stopped: "text-pending",
};

const CONFIDENCE_BAR_TONE: Record<string, string> = {
  success: "bg-success",
  error: "bg-error",
  warning: "bg-warning",
  info: "bg-info",
  pending: "bg-pending",
  stopped: "bg-pending",
};

export async function StageColumn({
  pipeline,
  stage,
  run,
}: {
  pipeline: Pipeline;
  stage: Stage;
  run?: Run;
}) {
  const runHref = run ? `/pipelines/${pipeline.id}/runs/${run.id}` : undefined;
  const confidencePct = run ? Math.round((run.confidenceScore ?? 0) * 100) : 0;
  const tone = run ? verdictTone(run.verdict) : "pending";
  const suspectPr = run?.change.pullRequests[0]?.number;
  const topFindings = run ? (await listFindings(run.id)).slice(0, 4) : [];

  return (
    <div className="awsui-container flex w-[336px] shrink-0 flex-col">
      <div className="awsui-container-header">
        <div className="flex items-center justify-between gap-2">
          <span className="text-text-secondary text-[12px] font-medium uppercase tracking-wide">
            Stage {stage.order}
          </span>
          {run && <RunStatusIndicator status={run.status} />}
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-3">
          <span className="text-[22px] font-medium capitalize tracking-tight text-text">{stage.name}</span>
          {stage.environmentUrl && (
            <a
              href={stage.environmentUrl}
              className="inline-flex items-center gap-1 text-[14px]"
              target="_blank"
              rel="noreferrer"
            >
              {stage.environmentUrl.replace(/^https?:\/\//, "")}
              <Icons.external />
            </a>
          )}
        </div>
      </div>

      <div className="border-t border-border p-4">
        <div className="flex flex-col gap-3 rounded-[8px] border border-border bg-page p-3.5">
          {run ? (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
                <Link href={runHref!} className="font-medium text-link">
                  Agentic QA
                </Link>
                <span className="text-border-strong">·</span>
                <span className="mono text-link">{shortSha(run.change.headSha)}</span>
                {suspectPr && (
                  <>
                    <span className="text-border-strong">·</span>
                    <span className="text-link">#{suspectPr}</span>
                  </>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-text-secondary text-[13px]">Agent confidence</span>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[32px] font-medium leading-none tracking-tight tabular-nums ${CONFIDENCE_TEXT_TONE[tone]}`}
                  >
                    {confidencePct}
                  </span>
                  <span className={`self-end pb-0.5 text-[14px] ${CONFIDENCE_TEXT_TONE[tone]}`}>%</span>
                  <span className="ml-1.5 h-[5px] min-w-[40px] flex-1 overflow-hidden rounded-full bg-border">
                    <span
                      className={`block h-full ${CONFIDENCE_BAR_TONE[tone]}`}
                      style={{ width: `${confidencePct}%` }}
                    />
                  </span>
                </div>
                {run.confidenceStatement && (
                  <span className="text-text-tertiary text-[12px]">{run.confidenceStatement}</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-text-secondary text-[13px]">Findings</span>
                <SeverityCounts counts={run.findings.bySeverity} />
              </div>
            </>
          ) : (
            <span className="text-text-secondary text-[13px]">
              Fleet of {stage.fleetSize} agents will run on next deployment
            </span>
          )}
        </div>
      </div>

      {topFindings.length > 0 && (
        <>
          <div className="border-t border-border" />
          <div className="flex flex-col gap-1 p-4">
            <span className="text-text-secondary text-[13px] font-medium">Top findings</span>
            <div className="divide-y divide-border">
              {topFindings.map((f) => (
                <Link
                  key={f.id}
                  href={`/pipelines/${pipeline.id}/runs/${run!.id}/findings/${f.id}`}
                  className="flex items-start gap-3 py-3 hover:no-underline"
                >
                  <SeverityBadge severity={f.severity} size="md" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium leading-snug text-text">{f.title}</div>
                    <div className="text-text-secondary mt-0.5 line-clamp-2 text-[13px] leading-snug">{f.summary}</div>
                    <div className="text-text-tertiary mt-1 text-[12px]">
                      {f.personaName} · <span className="mono">{f.agentId}</span>
                    </div>
                  </div>
                  <span className="shrink-0 self-center text-text-tertiary">
                    <Icons.chevronRight />
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="mt-auto border-t border-border">
        {run ? (
          <Link
            href={runHref!}
            className="flex w-full items-center gap-1.5 rounded-b-[12px] px-5 py-3.5 text-[14px] font-medium text-link hover:bg-nav-hover"
          >
            View run <Icons.chevronRight />
          </Link>
        ) : (
          <div className="px-5 py-3.5 text-[13px] text-text-tertiary">No run yet</div>
        )}
      </div>
    </div>
  );
}

/* ---------- Step row ---------- */

function StepRow({
  title,
  status,
  children,
}: {
  title: React.ReactNode;
  status: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-[8px] border border-border bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium">{title}</div>
        <div className="shrink-0 text-[12px]">{status}</div>
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

export function StageConnector() {
  return <div className="stage-connector" aria-hidden="true" />;
}
