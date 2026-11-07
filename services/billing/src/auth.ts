import type { FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { adminCapabilities, requiredAdminCapability, verifyAdminAuthority } from "@kasitek-labs/server-support/admin-authority";
import {
  BILLING_AUTHORITY_HEADER,
  verifyBillingAuthority,
  type BillingAuthority,
} from "@kasitek-labs/server-support/billing-authority";
import type { BillingConfig } from "./config.js";
import { unauthorized } from "./util.js";

const ADMIN_AUTHORITY_HEADER = "x-kasitek-admin-authority";

export interface RawBodyRequest extends FastifyRequest {
  rawBody?: string;
}

export async function rememberNonce(
  pool: Pool,
  nonce: string,
  issuer: string,
  expiresAt: number,
): Promise<boolean> {
  await pool.query(`DELETE FROM billing.request_nonces WHERE expires_at<=now()`);
  const result = await pool.query(
    `INSERT INTO billing.request_nonces(nonce, issuer, expires_at)
     VALUES($1,$2,to_timestamp($3 / 1000.0))
     ON CONFLICT (nonce) DO NOTHING`,
    [nonce, issuer, expiresAt],
  );
  return (result.rowCount ?? 0) === 1;
}

export async function requireProductAuthority(
  request: RawBodyRequest,
  pool: Pool,
  config: BillingConfig,
): Promise<BillingAuthority> {
  const token = request.headers[BILLING_AUTHORITY_HEADER];
  if (typeof token !== "string" || !token)
    throw unauthorized("Billing product authority is required");
  try {
    return await verifyBillingAuthority(token, {
      secret: config.internalSecret,
      method: request.method,
      path: request.url.split("?")[0]!,
      body: request.rawBody ?? "",
      nonceStore: {
        remember: (nonce, expiresAt) =>
          rememberNonce(pool, nonce, "product", expiresAt),
      },
    });
  } catch (error) {
    throw unauthorized(
      error instanceof Error ? error.message : "Invalid billing authority",
    );
  }
}

export async function requireAdminAuthority(
  request: RawBodyRequest,
  pool: Pool,
  config: BillingConfig,
  capability?: "admin:read" | "admin:write",
): Promise<{ id: string; role: string }> {
  if (!config.adminSecret)
    throw unauthorized("Billing admin authority is not configured");
  const token = request.headers[ADMIN_AUTHORITY_HEADER];
  if (typeof token !== "string" || !token)
    throw unauthorized("Billing admin authority is required");
  const required =
    capability ??
    (["GET", "HEAD", "OPTIONS"].includes(request.method)
      ? "admin:read"
      : (requiredAdminCapability(request.method, request.url) === "admin:report"
          ? "admin:read"
          : "admin:write"));
  try {
    const actor = verifyAdminAuthority(token, {
      secret: config.adminSecret,
      audience: config.adminAudience,
      method: request.method,
      path: request.url.split("?")[0]!,
      body: request.rawBody ?? "",
      capability: required,
    });
    if (!adminCapabilities(actor.role).has(required))
      throw new Error("Insufficient admin capability");
    if (
      !(await rememberNonce(
        pool,
        actor.nonce,
        "admin",
        actor.expiresAt,
      ))
    )
      throw new Error("Admin authority replay");
    return { id: actor.id, role: actor.role };
  } catch (error) {
    throw unauthorized(
      error instanceof Error ? error.message : "Invalid admin authority",
    );
  }
}

export async function audit(
  pool: Pool,
  actorId: string,
  action: string,
  resourceType: string,
  resourceId: string | null,
  details: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO billing.audit(id, actor_id, action, resource_type, resource_id, details)
     VALUES('aud_' || gen_random_uuid()::text,$1,$2,$3,$4,$5)`,
    [actorId, action, resourceType, resourceId, JSON.stringify(details ?? {})],
  );
}
