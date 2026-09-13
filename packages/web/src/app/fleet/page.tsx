import { getFleetSettings } from "@/lib/data";
import { FleetForm } from "@/components/fleet-form";
import { PageHeader, Pill, StatusIndicator } from "@/components/ui";

/**
 * Fleet-wide settings: how many agents run, how many runs at once, how
 * readily agents report, and the disposition mix. Saved to the control plane
 * and read at the start of every run.
 */
export default async function FleetPage() {
  const view = await getFleetSettings();
  const { activity } = view;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Fleet"
        subtitle="Fleet-wide defaults for every pipeline. Changes apply to the next run; per-stage fleet size and budget in a pipeline's Settings override these."
        meta={
          <>
            {view.orchestratorEnabled ? (
              <StatusIndicator tone={activity.active > 0 ? "info" : "success"}>
                {activity.active > 0
                  ? `${activity.active} run${activity.active === 1 ? "" : "s"} in flight${activity.queued ? `, ${activity.queued} queued` : ""}`
                  : "Orchestrator idle"}
              </StatusIndicator>
            ) : (
              <StatusIndicator tone="warning">Orchestrator disabled on this control plane (no ANTHROPIC_API_KEY); settings save but runs stay queued</StatusIndicator>
            )}
            <Pill tone={view.source === "saved" ? "info" : "neutral"}>{view.source === "saved" ? "Custom configuration" : "Environment defaults"}</Pill>
            {view.caps.maxAgentsPerRun !== null && <Pill>Operator cap: {view.caps.maxAgentsPerRun} agents/run</Pill>}
          </>
        }
      />
      <FleetForm initial={view} />
    </div>
  );
}
