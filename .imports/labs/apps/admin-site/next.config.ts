import type { NextConfig } from "next";

const CORE_BACKEND_URL =
  process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const TENANTS_BACKEND_URL =
  process.env.TENANTS_BACKEND_URL ?? "http://localhost:8090";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/core/:path*",
        destination: `${CORE_BACKEND_URL}/api/:path*`,
      },
      {
        source: "/api/tenants/:path*",
        destination: `${TENANTS_BACKEND_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
