import Link from "next/link";

export function TopNav() {
  return (
    <header className="sticky top-0 z-20 h-[52px] border-b border-border bg-nav">
      <div className="mx-auto flex h-full max-w-[1400px] items-center justify-between px-10">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-[14px] font-medium text-text hover:no-underline">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-text text-[12px] font-medium text-text-inverted">
              QA
            </span>
            Agentic QA
          </Link>
          <nav className="flex items-center gap-1 text-[14px]">
            <Link href="/" className="rounded-[6px] px-2 py-1 text-text hover:bg-nav-hover hover:no-underline">
              Pipelines
            </Link>
            <span className="cursor-not-allowed rounded-[6px] px-2 py-1 text-text-tertiary" title="Coming soon">
              Fleet
            </span>
            <span className="cursor-not-allowed rounded-[6px] px-2 py-1 text-text-tertiary" title="Coming soon">
              Ask the fleet
            </span>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-[13px] text-text-secondary">
          <span className="rounded-[6px] border border-border px-1.5 py-0 text-[11px] uppercase tracking-wide">
            Mock data
          </span>
          <span>acme-org</span>
        </div>
      </div>
    </header>
  );
}
