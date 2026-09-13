import { notFound } from "next/navigation";
import { getPipeline } from "@/lib/data";
import { Button, Code, Container, KeyValue, KeyValueGrid, Pill, StatusIndicator } from "@/components/ui";
import { formatDateTime, shortSha } from "@/lib/format";

export default async function SettingsPage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();

  return (
    <div className="space-y-5">
      <Container
        title="GitHub App"
        actions={
          <Button disabled title="Coming soon">
            Reconfigure
          </Button>
        }
      >
        <KeyValueGrid columns={4}>
          <KeyValue label="Repository">{pipeline.repository.fullName}</KeyValue>
          <KeyValue label="Installation id">
            <span className="mono">{pipeline.repository.installationId}</span>
          </KeyValue>
          <KeyValue label="Permissions">
            <div className="flex flex-wrap gap-1">
              {["contents:read", "pull_requests:read", "metadata:read", "checks:write"].map((p) => (
                <Pill key={p}>{p}</Pill>
              ))}
            </div>
          </KeyValue>
          <KeyValue label="Webhook">
            <StatusIndicator tone="success">Verified (HMAC-SHA256)</StatusIndicator>
          </KeyValue>
        </KeyValueGrid>
      </Container>

      <Container
        title="Stages"
        description="Each stage maps to a deployment branch. The cursor advances when a run starts, regardless of QA outcome."
        padded={false}
        actions={
          <Button disabled title="Coming soon">
            Add stage
          </Button>
        }
      >
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Stage</th>
              <th>Branch</th>
              <th>Environment</th>
              <th>Fleet size</th>
              <th>Gates promotion to</th>
              <th>Cursor</th>
            </tr>
          </thead>
          <tbody>
            {[...pipeline.stages]
              .sort((a, b) => a.order - b.order)
              .map((s) => (
                <tr key={s.id}>
                  <td className="text-text-secondary">{s.order}</td>
                  <td className="font-bold capitalize">{s.name}</td>
                  <td>
                    <Code>{s.branch}</Code>
                  </td>
                  <td>
                    {s.environmentUrl ? (
                      <a href={s.environmentUrl} target="_blank" rel="noreferrer">
                        {s.environmentUrl.replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>{s.fleetSize} agents</td>
                  <td>
                    {s.gatesPromotion && s.protectedBranch ? (
                      <Code>{s.protectedBranch}</Code>
                    ) : (
                      <span className="text-text-secondary">Not gating</span>
                    )}
                  </td>
                  <td>
                    {s.cursor ? (
                      <>
                        <span className="mono">{shortSha(s.cursor.sha)}</span>
                        {s.cursor.prNumber && <span className="mono"> · #{s.cursor.prNumber}</span>}
                        <div className="text-text-secondary text-[12px]">{formatDateTime(s.cursor.updatedAt)}</div>
                      </>
                    ) : (
                      <span className="text-text-secondary">Not set</span>
                    )}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </Container>

      <Container title="Triggers">
        <KeyValueGrid columns={2}>
          <KeyValue label="Default">
            <Code>push</Code> webhook on any stage branch
          </KeyValue>
          <KeyValue label="Override from CI">
            <Code>POST /api/pipelines/{pipeline.id}/runs</Code> with <Code>{"{ stage, sha }"}</Code>
          </KeyValue>
        </KeyValueGrid>
      </Container>
    </div>
  );
}
