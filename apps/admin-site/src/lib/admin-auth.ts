import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const CORE_BACKEND_URL =
  process.env.CORE_BACKEND_URL ?? "http://localhost:4000";
const TENANTS_BACKEND_URL =
  process.env.TENANTS_BACKEND_URL ?? "http://localhost:8090";
const ADMIN_SESSION_COOKIE = "kasitek_admin_session";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string;
}

function unavailableJsonResponse(service: string, error: unknown): Response {
  const message =
    error instanceof Error ? error.message : "Unable to reach upstream service";

  return new Response(
    JSON.stringify({
      error: `${service} is unavailable`,
      detail: message,
    }),
    {
      status: 503,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}

/**
 * Reads the admin session from the Core API.
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
 * Fetches from the Core API, forwarding the session cookie.
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
 * Fetches from the Tenant API with the admin secret header.
 * Use inside Server Components.
 */
export async function fetchFromTenants(
  path: string,
  init?: RequestInit
): Promise<Response> {
  const adminSecret = process.env.TENANT_ADMIN_SECRET ?? "";
  try {
    return await fetch(`${TENANTS_BACKEND_URL}${path}`, {
      headers: {
        ...(adminSecret ? { "x-admin-secret": adminSecret } : {}),
      },
      cache: "no-store",
      ...init,
    });
  } catch (error) {
    return unavailableJsonResponse("Tenant backend", error);
  }
}

/**
 * Proxies a request to the Core API, forwarding the session cookie.
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
  const idempotencyKey = req.headers.get("idempotency-key");
  const correlationId = req.headers.get("x-correlation-id");

  return fetch(target, {
    method: req.method,
    signal: req.signal,
    headers: {
      "Content-Type": "application/json",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(correlationId ? { "X-Correlation-Id": correlationId } : {}),
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
 * Proxies a request to the Tenant API, forwarding the admin secret.
 */
export async function proxyToTenants(
  req: Request,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const adminSecret = process.env.TENANT_ADMIN_SECRET ?? "";
  const url = new URL(req.url);
  const target = `${TENANTS_BACKEND_URL}${path}${url.search}`;

  try {
    return await fetch(target, {
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
  } catch (error) {
    return unavailableJsonResponse("Tenant backend", error);
  }
}
