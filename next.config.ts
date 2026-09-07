import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native (compiled) module; keep it out of Next's
  // server bundling so it's required directly from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
