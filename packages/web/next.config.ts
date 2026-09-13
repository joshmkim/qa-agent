import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // shared-types ships raw .ts; let Next compile it.
  transpilePackages: ["@qa-agent/shared-types"],
};

export default nextConfig;
