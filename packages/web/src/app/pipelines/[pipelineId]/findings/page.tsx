import { notFound } from "next/navigation";
import { getPipeline, listAllFindings, listRuns } from "@/lib/data";
import { Container } from "@/components/ui";
import { FindingsTable } from "@/components/findings-table";

export default async function FindingsPage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();
  const [findings, runs] = await Promise.all([listAllFindings(pipeline.id), listRuns(pipeline.id)]);
  const runsById = Object.fromEntries(runs.map((r) => [r.id, r]));

  return (
    <Container
      title={`Findings (${findings.length})`}
      description="Deduplicated findings across all runs, ranked by severity. Duplicates collapsed by triage are counted in the Dupes column."
      padded={false}
    >
      <FindingsTable pipelineId={pipeline.id} findings={findings} runsById={runsById} showRun />
    </Container>
  );
}
