/** Fixture-backed data source. Used when DATA_SOURCE=mock or no control plane is configured. */
import type { Finding, ManifestSnapshot, Pipeline, Run, Stage } from "@qa-agent/shared-types";
import { manifestSnapshot, pipeline } from "../mock/pipeline";
import { runs } from "../mock/runs";
import { findings } from "../mock/findings";

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;

export async function listPipelines(): Promise<Pipeline[]> {
  return [pipeline];
}

export async function getPipeline(id: string): Promise<Pipeline | undefined> {
  return id === pipeline.id ? pipeline : undefined;
}

export async function getStage(stageId: string): Promise<Stage | undefined> {
  return pipeline.stages.find((s) => s.id === stageId);
}

export async function getRun(runId: string): Promise<Run | undefined> {
  return runs.find((r) => r.id === runId);
}

export async function listRuns(pipelineId: string, stageId?: string): Promise<Run[]> {
  if (pipelineId !== pipeline.id) return [];
  return runs
    .filter((r) => (stageId ? r.stageId === stageId : true))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function listFindings(runId: string): Promise<Finding[]> {
  return findings
    .filter((f) => f.runId === runId)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export async function listAllFindings(pipelineId: string): Promise<Finding[]> {
  if (pipelineId !== pipeline.id) return [];
  return [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.reportedAt.localeCompare(a.reportedAt),
  );
}

export async function getFinding(findingId: string): Promise<Finding | undefined> {
  return findings.find((f) => f.id === findingId);
}

export async function getPipelineManifest(pipelineId: string): Promise<ManifestSnapshot | undefined> {
  return pipelineId === pipeline.id ? manifestSnapshot : undefined;
}

export async function getRunManifest(runId: string): Promise<ManifestSnapshot | undefined> {
  return runs.some((r) => r.id === runId) ? manifestSnapshot : undefined;
}
