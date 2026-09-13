import { notFound } from "next/navigation";
import { getPipeline } from "@/lib/data";
import { PipelineHeader } from "@/components/pipeline-header";

export default async function PipelineLayout({
  params,
  children,
}: {
  params: Promise<{ pipelineId: string }>;
  children: React.ReactNode;
}) {
  const { pipelineId } = await params;
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) notFound();

  return (
    <div className="space-y-4">
      <PipelineHeader pipeline={pipeline} />
      <div className="pt-1">{children}</div>
    </div>
  );
}
