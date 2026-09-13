"use server";

import { revalidatePath } from "next/cache";
import { getPipeline, triggerRun } from "./data";

export type TriggerRunResult = { ok: true; runId: string; runNumber: number } | { ok: false; error: string };

/**
 * "Trigger run" from the pipeline header. Runs on the Next server so the
 * control plane URL never reaches the browser. Returns a result instead of
 * throwing so the button can show the control plane's message inline
 * (no cursor yet, run already active, GitHub App not installed, ...).
 */
export async function triggerRunAction(pipelineId: string, stageName: string): Promise<TriggerRunResult> {
  const pipeline = await getPipeline(pipelineId);
  if (!pipeline) return { ok: false, error: "Pipeline not found" };
  if (!pipeline.stages.some((s) => s.name === stageName)) {
    return { ok: false, error: `Stage "${stageName}" is not part of this pipeline` };
  }
  try {
    const run = await triggerRun(pipeline.repository.fullName, stageName, "web");
    revalidatePath(`/pipelines/${pipelineId}`, "layout");
    revalidatePath("/");
    return { ok: true, runId: run.id, runNumber: run.number };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
