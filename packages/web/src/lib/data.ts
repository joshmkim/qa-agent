/**
 * Data access seam. Every page reads through these functions; the source is
 * picked once here, never per page.
 *
 * DATA_SOURCE=mock|api wins when set. Otherwise the control plane is used when
 * CONTROL_PLANE_URL is set, and fixtures when it isn't, so `pnpm dev` with no
 * env keeps working for UI iteration.
 */
import * as api from "./data/control-plane";
import * as mock from "./data/mock";

const useApi =
  process.env.DATA_SOURCE === "api" || (process.env.DATA_SOURCE !== "mock" && Boolean(process.env.CONTROL_PLANE_URL));

const source = useApi ? api : mock;

export const {
  listPipelines,
  getPipeline,
  getStage,
  getRun,
  listRuns,
  listFindings,
  listAllFindings,
  getFinding,
  getPipelineManifest,
  getRunManifest,
  triggerRun,
  getFleetSettings,
  saveFleetSettings,
  resetFleetSettings,
  FleetSettingsError,
} = source;

/** True when pages read from a control plane (writes like "Trigger run" are possible). */
export const canWrite = useApi;
