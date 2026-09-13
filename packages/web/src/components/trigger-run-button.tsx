"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { Stage } from "@qa-agent/shared-types";
import { triggerRunAction } from "@/lib/actions";

/**
 * "Trigger run" for the pipeline header: pick a stage, start a run at the
 * current head of its branch, then navigate to the new run. Disabled (with
 * the reason in the tooltip) when the UI is reading fixtures.
 */
export function TriggerRunButton({
  pipelineId,
  stages,
  enabled,
}: {
  pipelineId: string;
  stages: Stage[];
  enabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the picker on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const ordered = [...stages].sort((a, b) => a.order - b.order);

  const start = (stageName: string) => {
    setError(undefined);
    startTransition(async () => {
      const result = await triggerRunAction(pipelineId, stageName);
      if (result.ok) {
        setOpen(false);
        router.push(`/pipelines/${pipelineId}/runs/${result.runId}`);
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className={`btn ${enabled ? "btn-normal" : "btn-disabled"}`}
        disabled={!enabled || pending}
        title={enabled ? "Start a run at the current head of a stage branch" : "Runs can only be started against a control plane (set CONTROL_PLANE_URL)"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {pending ? "Starting…" : "Trigger run"}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Choose a stage"
          className="absolute right-0 z-30 mt-1 w-[300px] rounded-[8px] border border-border bg-surface p-1 shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
        >
          <div className="px-2 py-1.5 text-[12px] font-medium uppercase tracking-wide text-text-secondary">
            Run the fleet against
          </div>
          {ordered.map((s) => {
            const ready = Boolean(s.environmentUrl);
            return (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                disabled={pending || !ready}
                title={ready ? undefined : "Stage has no environment URL; set it in Settings first"}
                className="flex w-full items-start justify-between gap-3 rounded-[6px] px-2 py-2 text-left text-[14px] text-text hover:bg-nav-hover disabled:cursor-not-allowed disabled:text-text-tertiary disabled:hover:bg-transparent"
                onClick={() => start(s.name)}
              >
                <span>
                  <span className="font-medium capitalize">{s.name}</span>
                  <span className="text-text-secondary">
                    {" "}
                    · <span className="mono">{s.branch}</span> · {s.fleetSize} agents
                  </span>
                  {!ready && <div className="text-[12px] text-text-tertiary">No environment URL</div>}
                </span>
              </button>
            );
          })}
          {error && (
            <div role="alert" className="mx-1 mt-1 rounded-[6px] border border-border bg-page px-2 py-1.5 text-[12px] text-error">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
