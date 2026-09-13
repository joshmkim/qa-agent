import Image from "next/image";
import Link from "next/link";
import { listPipelines } from "@/lib/data";

export async function TopNav() {
  // The product under test, taken from the connected repositories rather than
  // a fixed name: "nike-storefront" -> "nike storefront".
  const pipelines = await listPipelines();
  const account =
    pipelines.length === 1
      ? pipelines[0]!.repository.name.replace(/[-_]+/g, " ")
      : pipelines.length > 1
        ? `${pipelines.length} pipelines`
        : undefined;
  return (
    <header className="sticky top-0 z-20 h-[52px] border-b border-border bg-nav">
      <div className="mx-auto flex h-full max-w-[1400px] items-center justify-between px-10">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-[14px] font-medium text-text hover:no-underline">
            <Image
              src="/bmo.jpg"
              alt="BMO Bot"
              width={24}
              height={24}
              className="h-6 w-6 rounded-[6px] object-cover"
              priority
            />
            BMO Bot
          </Link>
          <nav className="flex items-center gap-1 text-[14px]">
            <Link href="/" className="rounded-[6px] px-2 py-1 text-text hover:bg-nav-hover hover:no-underline">
              Pipelines
            </Link>
            <Link href="/fleet" className="rounded-[6px] px-2 py-1 text-text hover:bg-nav-hover hover:no-underline">
              Fleet
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-3 text-[13px] text-text-secondary">
          {account && <span>{account}</span>}
        </div>
      </div>
    </header>
  );
}
