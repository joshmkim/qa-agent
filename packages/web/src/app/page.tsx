import Link from "next/link";
import { isRunActive } from "@qa-agent/shared-types";
import { listPipelines, listRuns } from "@/lib/data";
import { AutoRefresh } from "@/components/auto-refresh";
import { PipelineHeader } from "@/components/pipeline-header";
import { PipelineOverview } from "@/components/pipeline-overview";
import { Container, Icons, PageHeader, RunStatusIndicator, SeverityCounts, Button } from "@/components/ui";
import { relativeTime } from "@/lib/format";

export default async function HomePage() {
  const pipelines = await listPipelines();

  if (pipelines.length === 0) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Pipelines"
          subtitle="Connect a repository through the GitHub App to start running the agent fleet against your deployments."
          actions={
            <Button variant="primary" disabled title="Coming soon">
              Connect repository
            </Button>
          }
        />
        <Container>
          <div className="text-text-secondary px-5 py-8 text-center">No pipelines connected yet.</div>
        </Container>
      </div>
    );
  }

  // The common case is a single connected pipeline: show its dashboard
  // directly on the homepage, matching the pipeline canvas format.
  if (pipelines.length === 1) {
    const pipeline = pipelines[0];
    return (
      <div className="space-y-4">
        <PipelineHeader pipeline={pipeline} showBreadcrumb={false} />
        <div className="pt-1">
          <PipelineOverview pipeline={pipeline} />
        </div>
      </div>
    );
  }

  // Multiple pipelines connected: fall back to an index so none are hidden.
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
                  <Link href={`/pipelines/${pipeline.id}`} className="font-medium">
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
