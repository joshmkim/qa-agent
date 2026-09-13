import Link from "next/link";
import { isRunActive } from "@qa-agent/shared-types";
import { listPipelines, listRuns } from "@/lib/data";
import { AutoRefresh } from "@/components/auto-refresh";
import { Container, Icons, PageHeader, RunStatusIndicator, SeverityCounts, Button } from "@/components/ui";
import { relativeTime } from "@/lib/format";

export default async function HomePage() {
  const pipelines = await listPipelines();
  const rows = await Promise.all(
    pipelines.map(async (p) => {
      const runs = await listRuns(p.id);
      return { pipeline: p, latest: runs[0] };
    }),
  );

  return (
    <div className="space-y-5">
      <AutoRefresh active={rows.some(({ latest }) => latest !== undefined && isRunActive(latest))} />
      <PageHeader
        title="Pipelines"
        subtitle="Repositories connected through the GitHub App. Each stage maps to a deployment branch and is gated by an agent fleet run."
        actions={
          <Button variant="primary" disabled title="Coming soon">
            Connect repository
          </Button>
        }
      />
      <Container padded={false}>
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Pipeline</th>
              <th>Repository</th>
              <th>Stages</th>
              <th>Latest run</th>
              <th>Findings</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ pipeline, latest }) => (
              <tr key={pipeline.id}>
                <td>
                  <Link href={`/pipelines/${pipeline.id}`} className="font-bold">
                    {pipeline.name}
                  </Link>
                </td>
                <td>
                  <span className="inline-flex items-center gap-1.5">
                    <Icons.github />
                    {pipeline.repository.fullName}
                  </span>
                </td>
                <td className="text-text-secondary">
                  {pipeline.stages.map((s) => s.name).join(" → ")}
                </td>
                <td>{latest ? <RunStatusIndicator status={latest.status} /> : "—"}</td>
                <td>{latest ? <SeverityCounts counts={latest.findings.bySeverity} compact /> : "—"}</td>
                <td className="text-text-secondary">{latest ? relativeTime(latest.startedAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Container>
    </div>
  );
}
