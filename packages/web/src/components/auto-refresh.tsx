"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the current server components on an interval while something on
 * the page is still in flight. Renders nothing; does nothing when inactive.
 */
export function AutoRefresh({ active, intervalMs = 15_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);

  return null;
}
