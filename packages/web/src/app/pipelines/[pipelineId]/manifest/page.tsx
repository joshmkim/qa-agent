import { notFound } from "next/navigation";
import { getPipeline, listInvariants, listSurfaces } from "@/lib/data";
import { Code, Container, Pill, SeverityBadge } from "@/components/ui";

export default async function ManifestPage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();
  const [surfaces, invariants] = await Promise.all([listSurfaces(), listInvariants()]);

  return (
    <div className="space-y-5">
      <Container
        title={`Invariants (${invariants.length})`}
        description="Team-authored statements that must always hold. Violations are scored automatically by the triage judge. This is the highest-leverage thing a team can maintain."
        padded={false}
      >
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Id</th>
              <th>Statement</th>
              <th>Check</th>
              <th>Severity</th>
            </tr>
          </thead>
          <tbody>
            {invariants.map((inv) => (
              <tr key={inv.id}>
                <td className="mono whitespace-nowrap">{inv.id}</td>
                <td className="max-w-[560px]">{inv.statement}</td>
                <td>{inv.check ? <Code>{inv.check}</Code> : <span className="text-text-secondary">LLM-judged</span>}</td>
                <td>
                  <SeverityBadge severity={inv.severityOnViolation} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Container>

      <Container
        title={`Surface inventory (${surfaces.length})`}
        description={
          <>
            Pages, forms, buttons, endpoints and flows the fleet is expected to cover. Source:{" "}
            <Code>{pipeline.manifestPath}</Code> @ {pipeline.manifestVersion}.
          </>
        }
        padded={false}
      >
        <table className="awsui-table">
          <thead>
            <tr>
              <th>Surface</th>
              <th>Kind</th>
              <th>Locator</th>
              <th>Touched by current change</th>
            </tr>
          </thead>
          <tbody>
            {surfaces.map((s) => (
              <tr key={s.id}>
                <td className="font-bold">{s.name}</td>
                <td>
                  <Pill>{s.kind}</Pill>
                </td>
                <td className="mono">{s.locator}</td>
                <td>{s.touchedByChange ? <Pill tone="info">Yes</Pill> : <span className="text-text-secondary">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Container>
    </div>
  );
}
