import type { Disposition, Severity } from "./context-bundle";

/**
 * How readily agents file findings. Rendered into every agent's system
 * prompt; the triage judge also drops anything below `minSeverity`.
 */
export type Scrutiny = "relaxed" | "balanced" | "thorough" | "exhaustive";

export const SCRUTINY_LEVELS: readonly Scrutiny[] = ["relaxed", "balanced", "thorough", "exhaustive"];
export const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2", "P3"];
export const DISPOSITIONS: readonly Disposition[] = ["methodical", "chaos-monkey", "adversarial-fuzzer", "impatient-user"];

/**
 * Fleet-wide configuration edited from the web UI (Fleet page) and stored by
 * the control plane. The orchestrator reads it at the start of every run, so
 * edits apply to the next run without a restart. Environment variables
 * supply the defaults; a saved config overrides them field by field.
 *
 * Scope: one config per control plane today. Per-tenant (installation) and
 * per-pipeline overlays slot in on top of this shape without changing it.
 */
export interface FleetConfig {
  /** Agents per run. A stage with `fleetSize > 0` overrides this. */
  agentsPerRun: number;
  /**
   * Runs orchestrated at the same time. Each orchestrator owns one run's wave
   * loop and triage; deployments beyond this wait in a queue. Peak browsers =
   * orchestrators x concurrency.
   */
  orchestrators: number;
  /** Agents (Chromium instances) in flight per run; the fleet runs in waves of this size. */
  concurrency: number;
  /** Wall-clock budget per agent in seconds. A stage with `budgetSeconds` overrides this. */
  agentBudgetSeconds: number;
  /** Tool-call ceiling per agent, regardless of time left. */
  maxSteps: number;
  /** How readily agents report what they see. */
  scrutiny: Scrutiny;
  /** Least severe finding that is reported. Findings below it are recorded as dismissed. */
  minSeverity: Severity;
  /** The gate blocks promotion when any distinct finding is at or above this severity. */
  blockOn: Severity;
  /** Relative weights per disposition; normalized when the fleet is allocated. */
  dispositionMix: Record<Disposition, number>;
  /** Focus surfaces handed to each agent. */
  focusPerAgent: number;
  /** Quiet visits (no new findings) before later waves are steered away from a surface. */
  saturationThreshold: number;
  /** Record a .webm per agent session. */
  recordVideo: boolean;
  /** Hosts, path prefixes or URL substrings the browser blocks outright. */
  blastRadiusBoundaries: string[];
  /** Team-authored instructions appended to every agent's system prompt. */
  teamInstructions: string;
  /** Model id for agents; empty = the agent runtime's default (AGENT_MODEL env or built-in). */
  model: string;
}

/** What GET /api/fleet returns: the effective config plus what it was derived from. */
export interface FleetConfigView {
  config: FleetConfig;
  /** Environment-derived defaults; "Reset to defaults" restores these. */
  defaults: FleetConfig;
  /** Operator caps from the control-plane environment; not editable from the UI. */
  caps: {
    /** MAX_FLEET_SIZE; null = uncapped. */
    maxAgentsPerRun: number | null;
  };
  /** False when the control plane has no model key: settings save, but runs stay queued. */
  orchestratorEnabled: boolean;
  /** Runs being orchestrated right now and waiting for an orchestrator. */
  activity: { active: number; queued: number };
  /** "saved" once someone has edited the config; "defaults" until then. */
  source: "defaults" | "saved";
  updatedAt?: string;
}

/** Built-in defaults; the control plane overlays its environment on these. */
export const DEFAULT_FLEET_CONFIG: FleetConfig = {
  agentsPerRun: 8,
  orchestrators: 1,
  concurrency: 4,
  agentBudgetSeconds: 600,
  maxSteps: 150,
  scrutiny: "balanced",
  minSeverity: "P3",
  blockOn: "P0",
  dispositionMix: { methodical: 40, "chaos-monkey": 25, "adversarial-fuzzer": 20, "impatient-user": 15 },
  focusPerAgent: 3,
  saturationThreshold: 2,
  recordVideo: false,
  blastRadiusBoundaries: [],
  teamInstructions: "",
  model: "",
};

/** Inclusive bounds for the numeric fields; shared by the API validator and the form. */
export const FLEET_CONFIG_LIMITS = {
  agentsPerRun: { min: 1, max: 200 },
  orchestrators: { min: 1, max: 16 },
  concurrency: { min: 1, max: 32 },
  agentBudgetSeconds: { min: 30, max: 3_600 },
  maxSteps: { min: 10, max: 1_000 },
  focusPerAgent: { min: 1, max: 10 },
  saturationThreshold: { min: 1, max: 10 },
  dispositionWeight: { min: 0, max: 100 },
} as const;

export const SEVERITY_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** True when `severity` is at least as severe as `floor` (P0 is the most severe). */
export function atLeastAsSevere(severity: Severity, floor: Severity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[floor];
}

/** Human copy for each scrutiny level; used by the form and the agent prompt. */
export const SCRUTINY_COPY: Record<Scrutiny, { label: string; summary: string }> = {
  relaxed: {
    label: "Relaxed",
    summary: "Only clear, reproducible breakage a user would notice: hard errors, broken flows, wrong numbers.",
  },
  balanced: {
    label: "Balanced",
    summary: "Confirmed bugs in primary and secondary flows, including ones with a workaround. Cosmetic issues only when they mislead.",
  },
  thorough: {
    label: "Thorough",
    summary: "Everything unexpected that can be confirmed, including layout glitches, inconsistent copy, slow responses and accessibility problems.",
  },
  exhaustive: {
    label: "Exhaustive",
    summary: "Every deviation from expected behavior, however small. When in doubt, file it; triage collapses duplicates.",
  },
};
