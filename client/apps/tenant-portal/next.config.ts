import type { NextConfig } from "next";

const tenantBackendUrl = (
  process.env.TENANT_BACKEND_URL ||
  process.env.NEXT_PUBLIC_TENANT_API_BASE_URL ||
  "http://localhost:8090"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/tenant/:path*",
        destination: `${tenantBackendUrl}/:path*`,
      },
    ];
  },
};

export default nextConfig;
