import Link from "next/link";

export function TopNav() {
  return (
    <header className="bg-nav text-text-inverted sticky top-0 z-20 h-10">
      <div className="mx-auto flex h-full max-w-[1600px] items-center justify-between px-5">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-[15px] font-bold text-white hover:no-underline">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-[6px] bg-[#ff9900] text-[13px] font-black text-nav">
              QA
            </span>
            Agentic QA
          </Link>
          <nav className="flex items-center gap-1 text-[14px]">
            <Link href="/" className="rounded-[4px] px-2 py-1 text-white/90 hover:bg-nav-hover hover:text-white hover:no-underline">
              Pipelines
            </Link>
            <span className="cursor-not-allowed rounded-[4px] px-2 py-1 text-white/50" title="Coming soon">
              Fleet
            </span>
            <span className="cursor-not-allowed rounded-[4px] px-2 py-1 text-white/50" title="Coming soon">
              Ask the fleet
            </span>
          </nav>
        </div>
        <div className="flex items-center gap-4 text-[13px] text-white/80">
          <span className="rounded-[4px] border border-white/20 px-1.5 py-0 text-[11px] uppercase tracking-wide">
            Mock data
          </span>
          <span>acme-org</span>
        </div>
      </div>
    </header>
  );
}
