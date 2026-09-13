import type { Metadata } from "next";
import "./globals.css";
import { TopNav } from "@/components/top-nav";

// Pipeline data is live from the control plane; never prerender at build time.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "BMOBot",
  description: "Fleet-driven QA gate for pre-production pipelines",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500&family=Geist+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen">
        <TopNav />
        <main className="mx-auto max-w-[1400px] px-10 pt-10 pb-16">{children}</main>
      </body>
    </html>
  );
}
