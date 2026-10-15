const DEFAULT_API_BASE_URL = "http://localhost:4000";

export function getApiBaseUrl() {
  // Browser requests stay on the app origin so the session and active-workspace
  // cookies reach the authenticated Core proxy. Direct browser-to-Core requests
  // are an opt-out for hosts that do not ship the Next API proxy.
  if (typeof window !== "undefined" && process.env.NEXT_PUBLIC_USE_API_PROXY !== "false") {
    return "";
  }

  return (
    process.env.CORE_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || DEFAULT_API_BASE_URL
  ).replace(/\/$/, "");
}

export function apiUrl(path: string) {
  return `${getApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
