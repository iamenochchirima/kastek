"use client";

export const DEFAULT_TENANT_API_BASE_URL = "/api/tenant";
const ACTIVE_WORKSPACE_KEY = "kasitek.agency.selected-workspace-slug";
export const AGENCY_BUSINESSES_CHANGED = "kasitek-agency-businesses-changed";

export function notifyAgencyBusinessesChanged() {
  window.dispatchEvent(new Event(AGENCY_BUSINESSES_CHANGED));
}

export function getTenantApiBaseUrl() {
  return DEFAULT_TENANT_API_BASE_URL;
}

export function tenantApiUrl(path: string) {
  return `${getTenantApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function selectAgencyWorkspace(slug: string) {
  if (typeof window !== "undefined") {
    window.localStorage.setItem(ACTIVE_WORKSPACE_KEY, slug);
  }
}

export function openAgencyWorkspace(slug: string, path = "/") {
  selectAgencyWorkspace(slug);
  if (typeof window !== "undefined") window.location.assign(path);
}

function activeWorkspaceSlug() {
  if (typeof window === "undefined") return null;
  const pathSlug = window.location.pathname.match(/^\/portal\/([^/]+)/)?.[1];
  if (pathSlug) {
    const slug = decodeURIComponent(pathSlug);
    selectAgencyWorkspace(slug);
    return slug;
  }
  return window.localStorage.getItem(ACTIVE_WORKSPACE_KEY);
}

export function getAgencyWorkspaceSlug() {
  return activeWorkspaceSlug();
}

export async function tenantFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const workspaceSlug = activeWorkspaceSlug();
  if (workspaceSlug) headers.set("x-kasitek-tenant-slug", workspaceSlug);
  const response = await fetch(tenantApiUrl(path), {
    credentials: "include",
    ...init,
    headers,
  });

  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.error || `Request failed with status ${response.status}`,
    );
  }

  return payload;
}
