import type { NextConfig } from "next";

const publicSiteUrl = "https://kasitek.co.za";

const nextConfig: NextConfig = {
  // Keep Next's development indicator out of the fixed dashboard sidebar.
  devIndicators: { position: "bottom-right" },
  // The development client is served through this public hostname. Next uses
  // the browser Origin to protect development/HMR connections, so the public
  // origin must be explicitly permitted or client-side hydration is blocked.
  allowedDevOrigins: ["dev-client.kasitek.co.za"],
  experimental: {
    useTypeScriptCli: false,
  },
  async redirects() {
    return [
      { source: "/about", destination: `${publicSiteUrl}/about`, permanent: true },
      { source: "/data-deletion", destination: `${publicSiteUrl}/data-deletion`, permanent: true },
      { source: "/demo", destination: `${publicSiteUrl}/demo`, permanent: true },
      { source: "/get-quote", destination: `${publicSiteUrl}/get-quote`, permanent: true },
      { source: "/meta-business-platform", destination: `${publicSiteUrl}/meta-business-platform`, permanent: true },
      { source: "/pricing", destination: `${publicSiteUrl}/pricing`, permanent: true },
      { source: "/pricing1", destination: `${publicSiteUrl}/pricing`, permanent: true },
      { source: "/privacy-policy", destination: `${publicSiteUrl}/privacy-policy`, permanent: true },
      { source: "/terms", destination: `${publicSiteUrl}/terms`, permanent: true },
      { source: "/waitlist", destination: `${publicSiteUrl}/waitlist`, permanent: true },
      { source: "/fliers", destination: publicSiteUrl, permanent: true },
      { source: "/solutions", destination: publicSiteUrl, permanent: true },
      { source: "/solutions/:path*", destination: publicSiteUrl, permanent: true },
    ];
  },
};

export default nextConfig;
