"use server";

import { revalidatePath } from "next/cache";
import type { FleetConfig, FleetConfigView } from "@qa-agent/shared-types";
import { FleetSettingsError, resetFleetSettings, saveFleetSettings } from "./data";

export type FleetSaveResult =
  | { ok: true; view: FleetConfigView }
  | { ok: false; error: string; issues: Array<{ path: string; message: string }> };

/**
 * Save from the Fleet page. Runs on the Next server so the control plane URL
 * never reaches the browser. Validation failures come back as a result (with
 * per-field issues) rather than a thrown error so the form can highlight them.
 */
export async function saveFleetAction(patch: Partial<FleetConfig>): Promise<FleetSaveResult> {
  try {
    const view = await saveFleetSettings(patch);
    revalidatePath("/fleet");
    return { ok: true, view };
  } catch (err) {
    if (err instanceof FleetSettingsError) return { ok: false, error: err.message, issues: err.issues };
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
}

export async function resetFleetAction(): Promise<FleetSaveResult> {
  try {
    const view = await resetFleetSettings();
    revalidatePath("/fleet");
    return { ok: true, view };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), issues: [] };
  }
}
