import type { NextConfig } from "next";

const localDistDir = process.env.NODE_ENV === "development" ? process.env.LOCAL_LABS_DIST_DIR : undefined;
if (localDistDir && !/^\.next-[a-z0-9-]+$/.test(localDistDir)) {
  throw new Error("LOCAL_LABS_DIST_DIR must be a .next- prefixed directory inside the Labs app");
}

const nextConfig: NextConfig = localDistDir ? { distDir: localDistDir } : {};

export default nextConfig;
