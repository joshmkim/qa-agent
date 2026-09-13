import Link from "next/link";
import type { ReactNode } from "react";
import type { GateVerdict, RunStatus, RunStep, Severity } from "@qa-agent/shared-types";

/* ---------- Layout ---------- */

export function Container({
  title,
  description,
  actions,
  children,
  className = "",
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={`awsui-container ${className}`}>
      {title !== undefined && (
        <header className="awsui-container-header flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[18px] font-bold leading-6">{title}</h2>
            {description && (
              <p className="text-text-secondary mt-0.5 text-[14px]">{description}</p>
            )}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  meta,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[28px] font-bold leading-9 tracking-tight">{title}</h1>
        {subtitle && <div className="text-text-secondary mt-1">{subtitle}</div>}
        {meta && <div className="mt-2 flex flex-wrap items-center gap-3">{meta}</div>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function KeyValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="kv-label">{label}</div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function KeyValueGrid({
  children,
  columns = 3,
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
}) {
  const cls =
    columns === 2
      ? "grid-cols-1 sm:grid-cols-2"
      : columns === 4
        ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4"
        : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";
  return <div className={`grid gap-x-8 gap-y-5 ${cls}`}>{children}</div>;
}

export function Button({
  href,
  variant = "normal",
  children,
  disabled,
  title,
}: {
  href?: string;
  variant?: "primary" | "normal";
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  const cls = `btn ${disabled ? "btn-disabled" : variant === "primary" ? "btn-primary" : "btn-normal"}`;
  if (href && !disabled) {
    return (
      <Link href={href} className={cls} title={title}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" className={cls} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "success" | "error" | "warning";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-pending-bg text-text-secondary border-border",
    info: "bg-info-bg text-info border-[#b5d6f4]",
    success: "bg-success-bg text-success border-[#a6dfab]",
    error: "bg-error-bg text-error border-[#f5b0b0]",
    warning: "bg-warning-bg text-warning border-[#f0dc8a]",
  };
  return (
    <span
      className={`inline-flex items-center rounded-[4px] border px-1.5 py-0 text-[12px] font-bold leading-[18px] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="mono rounded-[4px] border border-border bg-[#f8f9fa] px-1 py-0.5">
      {children}
    </code>
  );
}

/* ---------- Icons ---------- */

function IconBase({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`inline-block shrink-0 ${className}`}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const Icons = {
  success: () => (
    <IconBase className="text-success">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8l2 2 4-4" />
    </IconBase>
  ),
  error: () => (
    <IconBase className="text-error">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </IconBase>
  ),
  warning: () => (
    <IconBase className="text-warning">
      <path d="M8 2l6.5 11.5H1.5L8 2z" />
      <path d="M8 6.5v3M8 12v.01" />
    </IconBase>
  ),
  inProgress: () => (
    <IconBase className="text-info spin">
      <path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" />
    </IconBase>
  ),
  pending: () => (
    <IconBase className="text-pending">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5V8l2.5 1.5" />
    </IconBase>
  ),
  stopped: () => (
    <IconBase className="text-pending">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8h6" />
    </IconBase>
  ),
  external: () => (
    <IconBase className="text-current">
      <path d="M9 2h5v5M14 2L7 9M12 9v4.5H2.5V3H7" />
    </IconBase>
  ),
  github: () => (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" className="inline-block shrink-0">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
  agent: () => (
    <IconBase>
      <rect x="3" y="4" width="10" height="9" rx="2" />
      <path d="M8 1.5V4M6 8h.01M10 8h.01M6 11h4" />
    </IconBase>
  ),
  chevronRight: () => (
    <IconBase>
      <path d="M6 3l5 5-5 5" />
    </IconBase>
  ),
};

/* ---------- Status ---------- */

type Tone = "success" | "error" | "warning" | "info" | "pending" | "stopped";

const toneIcon: Record<Tone, () => ReactNode> = {
  success: Icons.success,
  error: Icons.error,
  warning: Icons.warning,
  info: Icons.inProgress,
  pending: Icons.pending,
  stopped: Icons.stopped,
};

const toneText: Record<Tone, string> = {
  success: "text-success",
  error: "text-error",
  warning: "text-warning",
  info: "text-info",
  pending: "text-pending",
  stopped: "text-pending",
};

export function StatusIndicator({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = toneIcon[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 font-bold ${toneText[tone]}`}>
      <Icon />
      <span>{children}</span>
    </span>
  );
}

export function runStatusTone(status: RunStatus): Tone {
  switch (status) {
    case "passed":
      return "success";
    case "blocked":
      return "error";
    case "failed":
      return "warning";
    case "cancelled":
      return "stopped";
    case "queued":
      return "pending";
    default:
      return "info";
  }
}

export function runStatusLabel(status: RunStatus): string {
  const labels: Record<RunStatus, string> = {
    queued: "Queued",
    "assembling-context": "Assembling context",
    exploring: "Exploring",
    triaging: "Triaging",
    passed: "Passed",
    blocked: "Blocked",
    failed: "Infra failure",
    cancelled: "Cancelled",
  };
  return labels[status];
}

export function RunStatusIndicator({ status }: { status: RunStatus }) {
  return <StatusIndicator tone={runStatusTone(status)}>{runStatusLabel(status)}</StatusIndicator>;
}

export function verdictTone(verdict: GateVerdict): Tone {
  return verdict === "pass"
    ? "success"
    : verdict === "block"
      ? "error"
      : verdict === "override"
        ? "warning"
        : "pending";
}

export function verdictLabel(verdict: GateVerdict): string {
  return verdict === "pass"
    ? "Promotion approved"
    : verdict === "block"
      ? "Promotion blocked"
      : verdict === "override"
        ? "Blocked, manually overridden"
        : "Awaiting verdict";
}

export function StepStatusIndicator({ status }: { status: RunStep["status"] }) {
  const map: Record<RunStep["status"], [Tone, string]> = {
    pending: ["pending", "Pending"],
    running: ["info", "In progress"],
    succeeded: ["success", "Succeeded"],
    failed: ["error", "Failed"],
    skipped: ["stopped", "Skipped"],
  };
  const [tone, label] = map[status];
  return <StatusIndicator tone={tone}>{label}</StatusIndicator>;
}

/* ---------- Severity ---------- */

export function SeverityBadge({ severity }: { severity: Severity }) {
  const cls: Record<Severity, string> = {
    P0: "bg-sev-p0 text-white",
    P1: "bg-sev-p1 text-white",
    P2: "bg-sev-p2 text-white",
    P3: "bg-sev-p3 text-white",
  };
  return (
    <span
      className={`inline-flex min-w-[30px] items-center justify-center rounded-[4px] px-1.5 text-[12px] font-bold leading-[18px] ${cls[severity]}`}
    >
      {severity}
    </span>
  );
}

export function SeverityCounts({
  counts,
  compact = false,
}: {
  counts: Record<Severity, number>;
  compact?: boolean;
}) {
  const order: Severity[] = ["P0", "P1", "P2", "P3"];
  return (
    <span className="inline-flex items-center gap-1.5">
      {order.map((s) =>
        compact && counts[s] === 0 ? null : (
          <span key={s} className="inline-flex items-center gap-1">
            <SeverityBadge severity={s} />
            <span className={counts[s] === 0 ? "text-text-secondary" : "font-bold"}>{counts[s]}</span>
          </span>
        ),
      )}
    </span>
  );
}

/* ---------- Progress ---------- */

export function ProgressBar({
  value,
  tone = "info",
  label,
}: {
  value: number; // 0..100
  tone?: "info" | "success" | "error" | "warning";
  label?: ReactNode;
}) {
  const bar: Record<string, string> = {
    info: "bg-info",
    success: "bg-success",
    error: "bg-error",
    warning: "bg-[#e0a800]",
  };
  return (
    <div>
      {label && <div className="mb-1 flex justify-between text-[12px] text-text-secondary">{label}</div>}
      <div className="h-2 w-full overflow-hidden rounded-full bg-[#e9ebed]">
        <div className={`h-full rounded-full ${bar[tone]}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}
