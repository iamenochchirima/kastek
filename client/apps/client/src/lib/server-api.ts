const DEFAULT_API_BASE_URL = "http://localhost:4000";

export function getApiBaseUrl() {
  // Core owns the authenticated API and explicitly allows the configured app origin. Keep the
  // direct browser path as the default because the Vercel runtime cannot be assumed to reach the
  // Railway Core service from every deployment region. Enable the proxy only for deployments
  // that have verified server-side access to the configured API origin.
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_USE_API_PROXY === "true") {
    return "";
  }

  return (
    process.env.RUST_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");
}

export function apiUrl(path: string) {
  return `${getApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
