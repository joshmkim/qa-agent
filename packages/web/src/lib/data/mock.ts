/** Fixture-backed data source. Used when DATA_SOURCE=mock or no control plane is configured. */
import {
  DEFAULT_FLEET_CONFIG,
  FLEET_CONFIG_LIMITS,
  type Finding,
  type FleetConfig,
  type FleetConfigView,
  type ManifestSnapshot,
  type Pipeline,
  type Run,
  type Stage,
} from "@qa-agent/shared-types";
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

// --- fleet configuration ---
// Lives for the dev server's lifetime so the Fleet page round-trips without a control plane.

const mockDefaults: FleetConfig = {
  ...DEFAULT_FLEET_CONFIG,
  dispositionMix: { ...DEFAULT_FLEET_CONFIG.dispositionMix },
  blastRadiusBoundaries: ["/admin"],
};
// On globalThis rather than a module variable: Next compiles the page (RSC
// layer) and the server actions (action layer) as separate module instances,
// so a plain `let` would not be shared between a save and the next render.
const g = globalThis as unknown as { __mockFleet?: { config: FleetConfig; updatedAt: string } };
const getSaved = () => g.__mockFleet;
const setSaved = (v: { config: FleetConfig; updatedAt: string } | undefined) => {
  g.__mockFleet = v;
};

export class FleetSettingsError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = "FleetSettingsError";
  }
}

function fleetView(): FleetConfigView {
  return {
    config: getSaved()?.config ?? mockDefaults,
    defaults: mockDefaults,
    caps: { maxAgentsPerRun: 8 },
    orchestratorEnabled: true,
    activity: { active: 0, queued: 0 },
    source: getSaved() ? "saved" : "defaults",
    updatedAt: getSaved()?.updatedAt,
  };
}

export async function getFleetSettings(): Promise<FleetConfigView> {
  return fleetView();
}

export async function saveFleetSettings(patch: Partial<FleetConfig>): Promise<FleetConfigView> {
  const base = getSaved()?.config ?? mockDefaults;
  const next: FleetConfig = {
    ...base,
    ...patch,
    dispositionMix: { ...base.dispositionMix, ...(patch.dispositionMix ?? {}) },
  };
  const issues: Array<{ path: string; message: string }> = [];
  for (const [key, range] of Object.entries(FLEET_CONFIG_LIMITS)) {
    if (key === "dispositionWeight") continue;
    const v = next[key as keyof FleetConfig] as number;
    if (!Number.isInteger(v) || v < range.min || v > range.max) issues.push({ path: key, message: `must be an integer between ${range.min} and ${range.max}` });
  }
  if (!Object.values(next.dispositionMix).some((w) => w > 0)) issues.push({ path: "dispositionMix", message: "at least one disposition needs a weight above 0" });
  if (next.blockOn > next.minSeverity) issues.push({ path: "blockOn", message: `must be at least as severe as minSeverity (${next.minSeverity})` });
  if (issues.length) throw new FleetSettingsError(`invalid fleet config: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, issues);
  setSaved({ config: next, updatedAt: new Date().toISOString() });
  return fleetView();
}

export async function resetFleetSettings(): Promise<FleetConfigView> {
  setSaved(undefined);
  return fleetView();
}

/** Fixtures are read-only; runs can only be started against a control plane. */
export async function triggerRun(_repositoryFullName: string, stageName: string): Promise<Run> {
  throw new Error(`Cannot start a run on "${stageName}" with fixture data. Start the web with CONTROL_PLANE_URL set.`);
}
