import { getAdminSession, type AdminUser } from "./admin-auth";
import { adminServiceHeaders } from "./admin-service-auth";

export function billingBackendUrl(): string {
  return (process.env.BILLING_BACKEND_URL ?? "http://127.0.0.1:4500").replace(/\/+$/, "");
}

export async function billingRequest(
  actor: AdminUser,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  const target = `${billingBackendUrl()}${path}`;
  return fetch(target, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...adminServiceHeaders(actor, "billing", method, path.split("?")[0]!, raw),
    },
    body: body === undefined ? undefined : raw,
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
}

export async function withBillingActor(
  run: (actor: AdminUser) => Promise<Response>,
): Promise<Response> {
  const actor = await getAdminSession();
  if (!actor) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await run(actor);
  } catch (error) {
    return Response.json(
      {
        error: "Billing service is unavailable",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 503 },
    );
  }
}

export async function billingJson<T>(
  actor: AdminUser,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await billingRequest(actor, method, path, body);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Billing request failed",
    );
  return payload as T;
}
