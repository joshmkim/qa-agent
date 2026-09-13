"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface Tab {
  label: string;
  href: string;
  /** Match when pathname starts with href (default: exact). */
  prefix?: boolean;
  disabled?: boolean;
}

export function Tabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname();
  return (
    <div className="border-b border-border" role="tablist">
      {tabs.map((t) => {
        const active = t.prefix ? pathname.startsWith(t.href) : pathname === t.href;
        if (t.disabled) {
          return (
            <span
              key={t.href}
              className="tab-link cursor-not-allowed !text-[#9ba7b6]"
              title="Coming soon"
              role="tab"
              aria-disabled="true"
            >
              {t.label}
            </span>
          );
        }
        return (
          <Link
            key={t.href}
            href={t.href}
            className="tab-link"
            data-active={active}
            role="tab"
            aria-selected={active}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
