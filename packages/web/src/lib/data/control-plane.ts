/** Control-plane backed data source. Server-only: reads CONTROL_PLANE_URL. */
import type { Finding, ManifestSnapshot, Pipeline, Run, Stage } from "@qa-agent/shared-types";

const baseUrl = (process.env.CONTROL_PLANE_URL ?? "http://localhost:3001").replace(/\/$/, "");

/** GET a control-plane JSON route. 404 -> undefined; anything else non-2xx throws. */
async function get<T>(path: string): Promise<T | undefined> {
  const res = await fetch(`${baseUrl}/api${path}`, { cache: "no-store" });
  if (res.status === 404) return undefined;
  if (!res.ok) {
    throw new Error(`Control plane GET ${path} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

const id = (value: string) => encodeURIComponent(value);

export async function listPipelines(): Promise<Pipeline[]> {
  return (await get<Pipeline[]>("/pipelines")) ?? [];
}

export async function getPipeline(pipelineId: string): Promise<Pipeline | undefined> {
  return get<Pipeline>(`/pipelines/${id(pipelineId)}`);
}

export async function getStage(stageId: string): Promise<Stage | undefined> {
  return get<Stage>(`/stages/${id(stageId)}`);
}

export async function getRun(runId: string): Promise<Run | undefined> {
  return get<Run>(`/runs/${id(runId)}`);
}

export async function listRuns(pipelineId: string, stageId?: string): Promise<Run[]> {
  const query = stageId ? `?stage=${id(stageId)}` : "";
  return (await get<Run[]>(`/pipelines/${id(pipelineId)}/runs${query}`)) ?? [];
}

export async function listFindings(runId: string): Promise<Finding[]> {
  return (await get<Finding[]>(`/runs/${id(runId)}/findings`)) ?? [];
}

export async function listAllFindings(pipelineId: string): Promise<Finding[]> {
  return (await get<Finding[]>(`/pipelines/${id(pipelineId)}/findings`)) ?? [];
}

export async function getFinding(findingId: string): Promise<Finding | undefined> {
  return get<Finding>(`/findings/${id(findingId)}`);
}

export async function getPipelineManifest(pipelineId: string): Promise<ManifestSnapshot | undefined> {
  return get<ManifestSnapshot>(`/pipelines/${id(pipelineId)}/manifest`);
}

export async function getRunManifest(runId: string): Promise<ManifestSnapshot | undefined> {
  return get<ManifestSnapshot>(`/runs/${id(runId)}/manifest`);
}

/**
 * Start a run on a stage now, at the current head of its branch. Mirrors the
 * CI trigger: POST /api/runs { repository, stage, triggeredBy }.
 */
export async function triggerRun(repositoryFullName: string, stageName: string, triggeredBy: string): Promise<Run> {
  const res = await fetch(`${baseUrl}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repository: repositoryFullName, stage: stageName, triggeredBy }),
    cache: "no-store",
  });
  if (!res.ok) {
    // The control plane answers RunErrors as { error, message } with 400/404/409.
    const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    throw new Error(body?.message ?? `Control plane POST /runs failed: ${res.status}`);
  }
  return (await res.json()) as Run;
}
