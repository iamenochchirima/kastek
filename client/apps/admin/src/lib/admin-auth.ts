import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const CORE_BACKEND_URL =
  process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

/**
 * Reads the admin session from the Rust backend.
 * Returns null if not authenticated.
 * Must only be called from Server Components / Route Handlers.
 */
export async function getAdminSession(): Promise<AdminUser | null> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE);
  if (!sessionCookie?.value) return null;

  try {
    const res = await fetch(`${CORE_BACKEND_URL}/api/admin/me`, {
      headers: {
        Cookie: `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`,
      },
      cache: "no-store",
    });

    if (!res.ok) return null;
    return (await res.json()) as AdminUser;
  } catch {
    return null;
  }
}

/**
 * Like getAdminSession but redirects to /login if not authenticated.
 */
export async function requireAdminSession(): Promise<AdminUser> {
  const admin = await getAdminSession();
  if (!admin) redirect("/login");
  return admin;
}

/**
 * Fetches from the core Rust backend, forwarding the session cookie.
 * Use inside Server Components (no Request object needed).
 */
export async function fetchFromCore(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE);
  const cookieHeader = sessionCookie
    ? `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`
    : "";

  return fetch(`${CORE_BACKEND_URL}${path}`, {
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    cache: "no-store",
    ...init,
  });
}

/**
 * Fetches from the tenants Rust backend with the admin secret header.
 * Use inside Server Components.
 */
export async function fetchFromTenants(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const adminSecret = process.env.TENANT_ADMIN_SECRET ?? "";
  return fetch(
    `${process.env.TENANTS_BACKEND_URL ?? "http://localhost:8090"}${path}`,
    {
      headers: {
        ...(adminSecret ? { "x-admin-secret": adminSecret } : {}),
      },
      cache: "no-store",
      ...init,
    }
  );
}

/**
 * Proxies a request to the core Rust backend, forwarding the session cookie.
 * Use inside Next.js Route Handlers.
 */
export async function proxyToCore(
  req: Request,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(ADMIN_SESSION_COOKIE);
  const cookieHeader = sessionCookie
    ? `${ADMIN_SESSION_COOKIE}=${sessionCookie.value}`
    : "";

  const url = new URL(req.url);
  const target = `${CORE_BACKEND_URL}${path}${url.search}`;

  return fetch(target, {
    method: req.method,
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
    body:
      req.method !== "GET" && req.method !== "HEAD"
        ? await req.text()
        : undefined,
    cache: "no-store",
    ...init,
  });
}

/**
 * Proxies a request to the tenant Rust backend, forwarding the admin secret.
 */
export async function proxyToTenants(
  req: Request,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const adminSecret = process.env.TENANT_ADMIN_SECRET ?? "";
  const url = new URL(req.url);
  const target = `${process.env.TENANTS_BACKEND_URL ?? "http://localhost:8090"}${path}${url.search}`;

  return fetch(target, {
    method: req.method,
    headers: {
      "Content-Type": "application/json",
      ...(adminSecret ? { "x-admin-secret": adminSecret } : {}),
    },
    body:
      req.method !== "GET" && req.method !== "HEAD"
        ? await req.text()
        : undefined,
    cache: "no-store",
    ...init,
  });
}
