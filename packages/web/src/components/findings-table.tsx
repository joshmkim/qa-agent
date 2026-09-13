import Link from "next/link";
import type { Finding, Run } from "@qa-agent/shared-types";
import { Pill, SeverityBadge, StatusIndicator } from "@/components/ui";
import { relativeTime } from "@/lib/format";

export function oracleLabel(oracle: Finding["oracle"]): string {
  return oracle === "hard-error" ? "Hard error" : oracle === "invariant" ? "Invariant" : "LLM judgment";
}

export function FindingStatusIndicator({ status }: { status: Finding["status"] }) {
  switch (status) {
    case "reproduced":
      return <StatusIndicator tone="error">Reproduced</StatusIndicator>;
    case "confirmed":
      return <StatusIndicator tone="warning">Confirmed</StatusIndicator>;
    case "duplicate":
      return <StatusIndicator tone="stopped">Duplicate</StatusIndicator>;
    case "dismissed":
      return <StatusIndicator tone="stopped">Dismissed</StatusIndicator>;
    default:
      return <StatusIndicator tone="info">New</StatusIndicator>;
  }
}

export function FindingsTable({
  pipelineId,
  findings,
  runsById,
  showRun = false,
}: {
  pipelineId: string;
  findings: Finding[];
  runsById?: Record<string, Run>;
  showRun?: boolean;
}) {
  if (findings.length === 0) {
    return <div className="text-text-secondary px-5 py-8 text-center">No findings reported for this run.</div>;
  }
  return (
    <table className="awsui-table">
      <thead>
        <tr>
          <th>Sev</th>
          <th>Finding</th>
          {showRun && <th>Run</th>}
          <th>Oracle</th>
          <th>Status</th>
          <th>Dupes</th>
          <th>Suspect PR</th>
          <th>Reported</th>
        </tr>
      </thead>
      <tbody>
        {findings.map((f) => {
          const run = runsById?.[f.runId];
          return (
            <tr key={f.id}>
              <td>
                <SeverityBadge severity={f.severity} />
              </td>
              <td className="max-w-[560px]">
                <Link href={`/pipelines/${pipelineId}/runs/${f.runId}/findings/${f.id}`} className="font-medium">
                  {f.title}
                </Link>
                <div className="text-text-secondary mt-0.5 line-clamp-2 text-[13px]">{f.summary}</div>
                <div className="mt-1 text-[12px] text-text-secondary">
                  {f.personaName} · <span className="mono">{f.agentId}</span>
                </div>
              </td>
              {showRun && (
                <td>
                  {run ? (
                    <Link href={`/pipelines/${pipelineId}/runs/${run.id}`}>#{run.number}</Link>
                  ) : (
                    <span className="mono">{f.runId}</span>
                  )}
                </td>
              )}
              <td>
                <Pill tone={f.oracle === "hard-error" ? "error" : f.oracle === "invariant" ? "warning" : "info"}>
                  {oracleLabel(f.oracle)}
                </Pill>
              </td>
              <td>
                <FindingStatusIndicator status={f.status} />
              </td>
              <td className="text-text-secondary">{f.triage?.duplicateCount ?? 0}</td>
              <td>
                {f.triage?.suspectedPrNumber ? (
                  <span className="mono">#{f.triage.suspectedPrNumber}</span>
                ) : (
                  <span className="text-text-secondary">—</span>
                )}
              </td>
              <td className="text-text-secondary whitespace-nowrap">{relativeTime(f.reportedAt)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
