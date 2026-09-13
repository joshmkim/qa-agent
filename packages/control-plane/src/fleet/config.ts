import { z } from "zod";
import {
  DEFAULT_FLEET_CONFIG,
  DISPOSITIONS,
  FLEET_CONFIG_LIMITS,
  SCRUTINY_LEVELS,
  SEVERITIES,
  type FleetConfig,
  type FleetConfigView,
} from "@qa-agent/shared-types";
import type { OrchestratorEnvConfig } from "../config";
import type { Store } from "../store";

const L = FLEET_CONFIG_LIMITS;
const int = (range: { min: number; max: number }) => z.number().int().min(range.min).max(range.max);

/** Validates a full config. Unknown keys are dropped so stale clients can't smuggle fields. */
export const fleetConfigSchema = z.object({
  agentsPerRun: int(L.agentsPerRun),
  orchestrators: int(L.orchestrators),
  concurrency: int(L.concurrency),
  agentBudgetSeconds: int(L.agentBudgetSeconds),
  maxSteps: int(L.maxSteps),
  scrutiny: z.enum(SCRUTINY_LEVELS as [string, ...string[]]),
  minSeverity: z.enum(SEVERITIES as [string, ...string[]]),
  blockOn: z.enum(SEVERITIES as [string, ...string[]]),
  dispositionMix: z
    .object(Object.fromEntries(DISPOSITIONS.map((d) => [d, int(L.dispositionWeight)])) as Record<(typeof DISPOSITIONS)[number], z.ZodNumber>)
    .refine((mix) => Object.values(mix).some((w) => w > 0), { message: "at least one disposition needs a weight above 0" }),
  focusPerAgent: int(L.focusPerAgent),
  saturationThreshold: int(L.saturationThreshold),
  recordVideo: z.boolean(),
  blastRadiusBoundaries: z.array(z.string().trim().min(1).max(200)).max(50),
  teamInstructions: z.string().max(4_000),
  model: z.string().trim().max(120),
});

export class FleetConfigError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }>,
  ) {
    super(message);
    this.name = "FleetConfigError";
  }
}

/**
 * Environment variables are the defaults; whatever the UI saved overrides
 * them field by field. Fields added to FleetConfig after a save therefore
 * pick up their default instead of being undefined.
 */
export function defaultsFromEnv(env: OrchestratorEnvConfig | undefined): FleetConfig {
  if (!env) return { ...DEFAULT_FLEET_CONFIG, dispositionMix: { ...DEFAULT_FLEET_CONFIG.dispositionMix } };
  return {
    ...DEFAULT_FLEET_CONFIG,
    dispositionMix: { ...DEFAULT_FLEET_CONFIG.dispositionMix },
    agentsPerRun: env.maxFleetSize > 0 ? Math.min(DEFAULT_FLEET_CONFIG.agentsPerRun, env.maxFleetSize) : DEFAULT_FLEET_CONFIG.agentsPerRun,
    concurrency: env.concurrency,
    agentBudgetSeconds: env.agentBudgetSeconds,
    maxSteps: env.maxSteps,
    saturationThreshold: env.saturationThreshold,
    recordVideo: env.recordVideo,
    blastRadiusBoundaries: [...env.blastRadiusBoundaries],
    model: env.model ?? "",
  };
}

export interface FleetConfigServiceDeps {
  store: Store;
  env: OrchestratorEnvConfig | undefined;
  /** Live orchestrator counters for the view; absent when the orchestrator is off. */
  activity?: () => { active: number; queued: number };
}

/** Owns reads/writes of the fleet config and the effective-config resolution. */
export class FleetConfigService {
  readonly defaults: FleetConfig;

  constructor(private readonly deps: FleetConfigServiceDeps) {
    this.defaults = defaultsFromEnv(deps.env);
  }

  /** The config the next run will use. */
  async resolve(): Promise<FleetConfig> {
    const stored = await this.deps.store.getFleetConfig();
    return stored ? overlay(this.defaults, stored.config) : this.defaults;
  }

  async view(): Promise<FleetConfigView> {
    const stored = await this.deps.store.getFleetConfig();
    return {
      config: stored ? overlay(this.defaults, stored.config) : this.defaults,
      defaults: this.defaults,
      caps: { maxAgentsPerRun: this.deps.env && this.deps.env.maxFleetSize > 0 ? this.deps.env.maxFleetSize : null },
      orchestratorEnabled: Boolean(this.deps.env),
      activity: this.deps.activity?.() ?? { active: 0, queued: 0 },
      source: stored ? "saved" : "defaults",
      updatedAt: stored?.updatedAt,
    };
  }

  /** Merge `patch` over the current effective config, validate, persist. */
  async save(patch: unknown): Promise<FleetConfigView> {
    if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
      throw new FleetConfigError("body must be a JSON object", []);
    }
    const current = await this.resolve();
    const candidate = overlay(current, patch as Partial<FleetConfig>);
    const parsed = fleetConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      throw new FleetConfigError(`invalid fleet config: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`, issues);
    }
    const next = parsed.data as FleetConfig;
    if (next.blockOn > next.minSeverity) {
      // Severities sort lexically (P0 < P3). Blocking below the reporting floor
      // could never trigger, which is almost certainly a mistake.
      throw new FleetConfigError(`invalid fleet config: blockOn (${next.blockOn}) is below the reporting floor (${next.minSeverity})`, [
        { path: "blockOn", message: `must be at least as severe as minSeverity (${next.minSeverity})` },
      ]);
    }
    await this.deps.store.putFleetConfig(next);
    return this.view();
  }

  async reset(): Promise<FleetConfigView> {
    await this.deps.store.deleteFleetConfig();
    return this.view();
  }
}

/** Shallow merge where only defined values from `patch` win; dispositionMix merges per key. */
function overlay(base: FleetConfig, patch: Partial<FleetConfig>): FleetConfig {
  const out: FleetConfig = { ...base, dispositionMix: { ...base.dispositionMix } };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    if (k === "dispositionMix" && typeof v === "object") {
      for (const d of DISPOSITIONS) {
        const w = (v as Record<string, unknown>)[d];
        if (typeof w === "number") out.dispositionMix[d] = w;
      }
      continue;
    }
    if (k in base) (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}
