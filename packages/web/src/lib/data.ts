/**
 * Data access seam. Every page reads through these functions so swapping the
 * mock for the control-plane API later is a one-file change.
 */
import type {
  Finding,
  Invariant,
  Pipeline,
  Run,
  Stage,
  Surface,
} from "@qa-agent/shared-types";
import { pipeline, invariants, surfaces } from "./mock/pipeline";
import { runs } from "./mock/runs";
import { findings } from "./mock/findings";

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

export async function getSurface(surfaceId: string): Promise<Surface | undefined> {
  return surfaces.find((s) => s.id === surfaceId);
}

export async function getInvariant(invariantId: string): Promise<Invariant | undefined> {
  return invariants.find((i) => i.id === invariantId);
}

export async function listSurfaces(): Promise<Surface[]> {
  return surfaces;
}

export async function listInvariants(): Promise<Invariant[]> {
  return invariants;
}
