import { notFound } from "next/navigation";
import { getPipeline } from "@/lib/data";
import { PipelineOverview } from "@/components/pipeline-overview";

export default async function PipelinePage({ params }: { params: Promise<{ pipelineId: string }> }) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();

  return <PipelineOverview pipeline={pipeline} />;
}
