"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";
import {
  DISPOSITIONS,
  FLEET_CONFIG_LIMITS,
  SCRUTINY_COPY,
  SCRUTINY_LEVELS,
  SEVERITIES,
  type Disposition,
  type FleetConfig,
  type FleetConfigView,
  type Scrutiny,
  type Severity,
} from "@qa-agent/shared-types";
import { resetFleetAction, saveFleetAction } from "@/lib/fleet-actions";
import { Container, KeyValue, KeyValueGrid, Pill, SeverityBadge } from "@/components/ui";

const L = FLEET_CONFIG_LIMITS;

const DISPOSITION_COPY: Record<Disposition, { label: string; summary: string }> = {
  methodical: { label: "Methodical", summary: "Completes every flow end to end and checks numbers against the invariants. Carries coverage." },
  "chaos-monkey": { label: "Chaos monkey", summary: "Double-submits, refreshes mid-flow, goes back after a POST. Hunts state bugs." },
  "adversarial-fuzzer": { label: "Adversarial fuzzer", summary: "Boundary values, malformed ids, other users' ids, direct API calls. Stays inside the blast radius." },
  "impatient-user": { label: "Impatient user", summary: "Clicks fast, skips instructions, notices anything that silently fails." },
};

const SEVERITY_COPY: Record<Severity, string> = {
  P0: "release-blocking: crash, data loss, money wrong",
  P1: "core flow degraded, no workaround",
  P2: "secondary flow broken, or workaround exists",
  P3: "cosmetic",
};

type Issues = Record<string, string>;

/** Same rules the control plane enforces, so the form can flag problems before a round trip. */
function validate(c: FleetConfig): Issues {
  const issues: Issues = {};
  const check = (key: keyof typeof L & keyof FleetConfig) => {
    const v = c[key] as number;
    const r = L[key];
    if (!Number.isInteger(v) || v < r.min || v > r.max) issues[key] = `Whole number between ${r.min} and ${r.max}`;
  };
  check("agentsPerRun");
  check("orchestrators");
  check("concurrency");
  check("agentBudgetSeconds");
  check("maxSteps");
  check("focusPerAgent");
  check("saturationThreshold");
  if (!DISPOSITIONS.some((d) => c.dispositionMix[d] > 0)) issues.dispositionMix = "Give at least one disposition a weight above 0";
  if (c.blockOn > c.minSeverity) issues.blockOn = `Blocking on ${c.blockOn} can never trigger while the reporting floor is ${c.minSeverity}`;
  if (c.model.length > 120) issues.model = "Model id is too long";
  if (c.teamInstructions.length > 4_000) issues.teamInstructions = "Keep team instructions under 4,000 characters";
  return issues;
}

function clone(c: FleetConfig): FleetConfig {
  return { ...c, dispositionMix: { ...c.dispositionMix }, blastRadiusBoundaries: [...c.blastRadiusBoundaries] };
}

function same(a: FleetConfig, b: FleetConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function minutes(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = seconds / 60;
  return Number.isInteger(m) ? `${m} min` : `${m.toFixed(1)} min`;
}

export function FleetForm({ initial }: { initial: FleetConfigView }) {
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState(() => clone(initial.config));
  const [serverIssues, setServerIssues] = useState<Issues>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | undefined>();
  const [pending, startTransition] = useTransition();

  const clientIssues = useMemo(() => validate(draft), [draft]);
  const issues = { ...serverIssues, ...clientIssues };
  const dirty = !same(draft, view.config);
  const atDefaults = same(draft, view.defaults);

  const set = <K extends keyof FleetConfig>(key: K, value: FleetConfig[K]) => {
    setNotice(undefined);
    setServerIssues((s) => {
      if (!(key in s)) return s;
      const next = { ...s };
      delete next[key];
      return next;
    });
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const setNumber = (key: keyof FleetConfig) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = e.target.valueAsNumber;
    set(key, (Number.isFinite(n) ? Math.round(n) : 0) as never);
  };

  const save = () => {
    setNotice(undefined);
    startTransition(async () => {
      const result = await saveFleetAction(draft);
      if (result.ok) {
        setView(result.view);
        setDraft(clone(result.view.config));
        setServerIssues({});
        setNotice({ tone: "success", text: "Saved. The next run picks these up; runs already in flight keep their settings." });
      } else {
        setServerIssues(Object.fromEntries(result.issues.map((i) => [i.path.split(".")[0] ?? i.path, i.message])));
        setNotice({ tone: "error", text: result.error });
      }
    });
  };

  const reset = () => {
    setNotice(undefined);
    startTransition(async () => {
      const result = await resetFleetAction();
      if (result.ok) {
        setView(result.view);
        setDraft(clone(result.view.config));
        setServerIssues({});
        setNotice({ tone: "success", text: "Back to the control plane's environment defaults." });
      } else {
        setNotice({ tone: "error", text: result.error });
      }
    });
  };

  const discard = () => {
    setDraft(clone(view.config));
    setServerIssues({});
    setNotice(undefined);
  };

  // --- derived numbers for the summary strip ---
  const cap = view.caps.maxAgentsPerRun;
  const effectiveAgents = cap !== null ? Math.min(draft.agentsPerRun, cap) : draft.agentsPerRun;
  const capped = cap !== null && draft.agentsPerRun > cap;
  const waves = Math.max(1, Math.ceil(effectiveAgents / Math.max(1, draft.concurrency)));
  const peakBrowsers = Math.max(1, draft.orchestrators) * Math.max(1, draft.concurrency);
  const runSeconds = waves * draft.agentBudgetSeconds;
  const mixTotal = DISPOSITIONS.reduce((n, d) => n + Math.max(0, draft.dispositionMix[d]), 0);
  const share = (d: Disposition) => (mixTotal > 0 ? Math.max(0, draft.dispositionMix[d]) / mixTotal : 0);

  return (
    <div className="space-y-5 pb-20">
      <Container title="Capacity at a glance" description="What one deployment costs with the settings below, before you save them.">
        <KeyValueGrid columns={4}>
          <KeyValue label="Agents per run">
            <span className="text-[20px] font-medium">{effectiveAgents}</span>
            {capped && (
              <div className="mt-1">
                <Pill tone="warning">Capped from {draft.agentsPerRun} by MAX_FLEET_SIZE={cap}</Pill>
              </div>
            )}
          </KeyValue>
          <KeyValue label="Waves per run">
            <span className="text-[20px] font-medium">{waves}</span>
            <span className="text-text-secondary"> × {Math.min(draft.concurrency, effectiveAgents)} agents</span>
          </KeyValue>
          <KeyValue label="Peak browsers">
            <span className="text-[20px] font-medium">{peakBrowsers}</span>
            <span className="text-text-secondary">
              {" "}
              = {draft.orchestrators} orchestrator{draft.orchestrators === 1 ? "" : "s"} × {draft.concurrency} in flight
            </span>
          </KeyValue>
          <KeyValue label="Run time (upper bound)">
            <span className="text-[20px] font-medium">≈ {minutes(runSeconds)}</span>
            <span className="text-text-secondary"> + triage</span>
          </KeyValue>
        </KeyValueGrid>
      </Container>

      <Container title="Capacity" description="How many agents run, how many at once, and how long each one gets.">
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            id="agentsPerRun"
            label="Agents per run"
            hint={`Default for every stage. A stage with its own fleet size overrides it. ${cap !== null ? `The control plane caps runs at ${cap} (MAX_FLEET_SIZE).` : ""}`}
            error={issues.agentsPerRun}
          >
            <NumberWithRange id="agentsPerRun" value={draft.agentsPerRun} range={L.agentsPerRun} onChange={setNumber("agentsPerRun")} sliderMax={Math.max(40, cap ?? 0)} />
          </Field>
          <Field
            id="orchestrators"
            label="Orchestrators"
            hint="Runs coordinated at the same time. Each orchestrator owns one run's waves and triage; further deployments queue."
            error={issues.orchestrators}
          >
            <NumberWithRange id="orchestrators" value={draft.orchestrators} range={L.orchestrators} onChange={setNumber("orchestrators")} />
          </Field>
          <Field
            id="concurrency"
            label="Agents in flight"
            hint="Browsers open at once per run. The fleet runs in waves of this size; later waves are steered away from surfaces earlier waves saturated."
            error={issues.concurrency}
          >
            <NumberWithRange id="concurrency" value={draft.concurrency} range={L.concurrency} onChange={setNumber("concurrency")} sliderMax={16} />
          </Field>
          <Field
            id="agentBudgetSeconds"
            label="Time budget per agent"
            hint={`Seconds of wall clock each agent gets (${minutes(draft.agentBudgetSeconds)}). A stage with its own budget overrides it. Agents are warned near the end and asked to summarize.`}
            error={issues.agentBudgetSeconds}
          >
            <NumberWithRange id="agentBudgetSeconds" value={draft.agentBudgetSeconds} range={L.agentBudgetSeconds} step={30} onChange={setNumber("agentBudgetSeconds")} sliderMax={1_800} />
          </Field>
          <Field id="maxSteps" label="Actions per agent" hint="Ceiling on tool calls (clicks, navigations, API calls) regardless of time left. Bounds model spend." error={issues.maxSteps}>
            <NumberWithRange id="maxSteps" value={draft.maxSteps} range={L.maxSteps} step={10} onChange={setNumber("maxSteps")} sliderMax={400} />
          </Field>
        </div>
      </Container>

      <Container title="Reporting" description="How readily agents file what they see, and what stops a promotion.">
        <div className="space-y-6">
          <Field id="scrutiny" label="Scrutiny" hint="Rendered into every agent's system prompt as the bar for filing a finding." error={issues.scrutiny}>
            <div className="segmented" role="group" aria-label="Scrutiny">
              {SCRUTINY_LEVELS.map((level) => (
                <button key={level} type="button" aria-pressed={draft.scrutiny === level} onClick={() => set("scrutiny", level as Scrutiny)}>
                  {SCRUTINY_COPY[level].label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[13px] text-text-secondary">{SCRUTINY_COPY[draft.scrutiny].summary}</p>
          </Field>

          <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
            <Field
              id="minSeverity"
              label="Report findings at or above"
              hint="Agents are told not to file below this; the triage judge dismisses anything that slips through. P3 reports everything."
              error={issues.minSeverity}
            >
              <SeveritySelect id="minSeverity" value={draft.minSeverity} onChange={(v) => set("minSeverity", v)} />
            </Field>
            <Field
              id="blockOn"
              label="Block promotion on"
              hint="The gate fails and the check run turns red when any distinct finding is at least this severe."
              error={issues.blockOn}
            >
              <SeveritySelect id="blockOn" value={draft.blockOn} onChange={(v) => set("blockOn", v)} invalid={Boolean(issues.blockOn)} />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-text-secondary">
            <span>With these settings:</span>
            {SEVERITIES.map((s) => {
              const reported = s <= draft.minSeverity;
              const blocks = s <= draft.blockOn;
              return (
                <span key={s} className="inline-flex items-center gap-1">
                  <SeverityBadge severity={s} size="sm" />
                  <span className={reported ? "" : "line-through"}>{blocks ? "blocks" : reported ? "reported" : "dismissed"}</span>
                </span>
              );
            })}
          </div>
        </div>
      </Container>

      <Container
        title="Disposition mix"
        description="Relative weights. Each run's agents are split across the four dispositions in this ratio, interleaved so every wave has a mix."
      >
        <div className="mb-5 flex h-2 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
          {DISPOSITIONS.map((d, i) => (
            <div key={d} className={["bg-info", "bg-[#8a2a22]", "bg-warning", "bg-[#4f8f7d]"][i]} style={{ width: `${share(d) * 100}%` }} />
          ))}
        </div>
        {issues.dispositionMix && (
          <p role="alert" className="mb-3 text-[13px] text-error">
            {issues.dispositionMix}
          </p>
        )}
        <div className="space-y-4">
          {DISPOSITIONS.map((d, i) => {
            const agents = Math.round(share(d) * effectiveAgents);
            return (
              <div key={d} className="grid items-center gap-x-6 gap-y-1 sm:grid-cols-[220px_1fr_140px]">
                <div>
                  <label htmlFor={`mix-${d}`} className="flex items-center gap-2 text-[14px] font-medium">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${["bg-info", "bg-[#8a2a22]", "bg-warning", "bg-[#4f8f7d]"][i]}`} aria-hidden="true" />
                    {DISPOSITION_COPY[d].label}
                  </label>
                  <div className="text-[12px] text-text-secondary">{DISPOSITION_COPY[d].summary}</div>
                </div>
                <input
                  id={`mix-${d}`}
                  type="range"
                  className="range"
                  min={L.dispositionWeight.min}
                  max={L.dispositionWeight.max}
                  value={draft.dispositionMix[d]}
                  onChange={(e) => set("dispositionMix", { ...draft.dispositionMix, [d]: e.target.valueAsNumber })}
                  aria-valuetext={`${draft.dispositionMix[d]} weight, ${Math.round(share(d) * 100)} percent`}
                />
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    className="input w-[72px]"
                    aria-label={`${DISPOSITION_COPY[d].label} weight`}
                    min={L.dispositionWeight.min}
                    max={L.dispositionWeight.max}
                    value={draft.dispositionMix[d]}
                    onChange={(e) => {
                      const n = e.target.valueAsNumber;
                      set("dispositionMix", { ...draft.dispositionMix, [d]: Number.isFinite(n) ? Math.round(n) : 0 });
                    }}
                  />
                  <span className="mono w-[64px] text-text-secondary">
                    {Math.round(share(d) * 100)}% · {agents}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Container>

      <Container title="Exploration" description="How the fleet spreads out over the surface inventory.">
        <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field
            id="focusPerAgent"
            label="Focus surfaces per agent"
            hint="Distinct manifest surfaces each agent is pointed at. Surfaces touched by the change are handed out first."
            error={issues.focusPerAgent}
          >
            <NumberWithRange id="focusPerAgent" value={draft.focusPerAgent} range={L.focusPerAgent} onChange={setNumber("focusPerAgent")} />
          </Field>
          <Field
            id="saturationThreshold"
            label="Saturation threshold"
            hint="Quiet visits (no new findings) before later waves are steered away from a surface. Lower spreads faster; higher digs deeper."
            error={issues.saturationThreshold}
          >
            <NumberWithRange id="saturationThreshold" value={draft.saturationThreshold} range={L.saturationThreshold} onChange={setNumber("saturationThreshold")} />
          </Field>
          <Field id="model" label="Model" hint="Anthropic model id for agents. Leave empty for the control plane's default (AGENT_MODEL)." error={issues.model}>
            <input
              id="model"
              type="text"
              className="input mono"
              placeholder={view.defaults.model || "runtime default"}
              value={draft.model}
              onChange={(e) => set("model", e.target.value)}
              aria-invalid={Boolean(issues.model)}
            />
          </Field>
          <Field id="recordVideo" label="Record video" hint="Save a .webm of every agent session and attach it as evidence to its findings. A few MB per agent.">
            <div className="flex items-center gap-3">
              <button
                id="recordVideo"
                type="button"
                role="switch"
                className="switch"
                aria-checked={draft.recordVideo}
                onClick={() => set("recordVideo", !draft.recordVideo)}
              />
              <span className="text-[14px]">{draft.recordVideo ? "On" : "Off"}</span>
            </div>
          </Field>
        </div>
      </Container>

      <Container title="Boundaries and instructions" description="Hard limits the browser enforces, and words every agent reads.">
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
          <Field
            id="blastRadiusBoundaries"
            label="Blast radius (one per line)"
            hint="Hosts, path prefixes or URL substrings agents must never hit. Matching requests are blocked in the browser. The manifest's policy boundaries are separate and read by agents."
            error={issues.blastRadiusBoundaries}
          >
            <textarea
              id="blastRadiusBoundaries"
              className="textarea mono"
              rows={5}
              placeholder={"/admin\npayments.example.com\n/api/internal"}
              value={draft.blastRadiusBoundaries.join("\n")}
              onChange={(e) =>
                set(
                  "blastRadiusBoundaries",
                  e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
              aria-invalid={Boolean(issues.blastRadiusBoundaries)}
            />
          </Field>
          <Field
            id="teamInstructions"
            label="Team instructions"
            hint={`Appended to every agent's system prompt as "Team instructions". Good for test-account hints, areas to avoid, what to verify by hand. ${draft.teamInstructions.length}/4000`}
            error={issues.teamInstructions}
          >
            <textarea
              id="teamInstructions"
              className="textarea"
              rows={5}
              placeholder="e.g. Promo code YR24 is a known beta bug; do not re-report it. Always verify the cart total after applying a discount."
              value={draft.teamInstructions}
              onChange={(e) => set("teamInstructions", e.target.value)}
              aria-invalid={Boolean(issues.teamInstructions)}
            />
          </Field>
        </div>
      </Container>

      {/* Save bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-nav/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-10 py-3">
          <div className="flex min-w-0 items-center gap-3 text-[13px]">
            {notice ? (
              <span role="status" className={notice.tone === "error" ? "text-error" : "text-success"}>
                {notice.text}
              </span>
            ) : dirty ? (
              <span className="text-text">Unsaved changes</span>
            ) : (
              <span className="text-text-secondary">
                {view.source === "saved" && view.updatedAt ? `Saved ${new Date(view.updatedAt).toLocaleString()}` : "Using environment defaults"}
              </span>
            )}
            {Object.keys(clientIssues).length > 0 && (
              <Pill tone="error">
                {Object.keys(clientIssues).length} field{Object.keys(clientIssues).length === 1 ? "" : "s"} need attention
              </Pill>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className={`btn ${atDefaults && view.source === "defaults" ? "btn-disabled" : "btn-normal"}`} disabled={pending || (atDefaults && view.source === "defaults")} onClick={reset} title="Clear the saved config and go back to the control plane's environment defaults">
              Reset to defaults
            </button>
            <button type="button" className={`btn ${dirty ? "btn-normal" : "btn-disabled"}`} disabled={!dirty || pending} onClick={discard}>
              Discard
            </button>
            <button
              type="button"
              className={`btn ${dirty && Object.keys(clientIssues).length === 0 ? "btn-primary" : "btn-disabled"}`}
              disabled={!dirty || pending || Object.keys(clientIssues).length > 0}
              onClick={save}
            >
              {pending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- field primitives ---------- */

function Field({ id, label, hint, error, children }: { id: string; label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="block text-[14px] font-medium">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-[12px] text-error">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-[12px] text-text-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function NumberWithRange({
  id,
  value,
  range,
  step = 1,
  sliderMax,
  onChange,
}: {
  id: string;
  value: number;
  range: { min: number; max: number };
  step?: number;
  /** Slider stops here for a usable drag; the text input still accepts up to range.max. */
  sliderMax?: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  const max = Math.min(range.max, sliderMax ?? range.max);
  const invalid = !Number.isInteger(value) || value < range.min || value > range.max;
  return (
    <div className="flex items-center gap-3">
      <input id={id} type="number" className="input w-[96px]" min={range.min} max={range.max} step={step} value={value} onChange={onChange} aria-invalid={invalid} aria-describedby={`${id}-hint`} />
      <input
        type="range"
        className="range"
        aria-label={`${id} slider`}
        min={range.min}
        max={max}
        step={step}
        value={Math.min(value, max)}
        onChange={onChange}
      />
    </div>
  );
}

function SeveritySelect({ id, value, onChange, invalid }: { id: string; value: Severity; onChange: (v: Severity) => void; invalid?: boolean }) {
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as Severity)} aria-invalid={invalid}>
      {SEVERITIES.map((s) => (
        <option key={s} value={s}>
          {s} · {SEVERITY_COPY[s]}
        </option>
      ))}
    </select>
  );
}
