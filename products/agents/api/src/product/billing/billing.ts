import type { Pool } from "pg";
import { BillingClient } from "@kasitek-labs/server-support/billing-client";
import { PlatformError } from "../../contracts/contracts";

export function agentsBillingClient(
  env: NodeJS.ProcessEnv = process.env,
): BillingClient | null {
  return BillingClient.fromEnvironment("agents", env);
}

export function agentsBillingEnforcementEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return ["1", "true", "yes", "on"].includes(
    (env.AGENTS_BILLING_ENFORCEMENT ?? "").trim().toLowerCase(),
  );
}

export async function ensureAgentsBillingAccount(
  pool: Pool,
  client: BillingClient,
  organizationId: string,
): Promise<void> {
  const row = await pool.query<{
    name: string;
    email: string | null;
    issuer: string | null;
    subject: string | null;
  }>(
    `SELECT o.name, a.email, a.issuer, a.subject
       FROM agents_platform.organizations o
       JOIN agents_platform.memberships m
         ON m.organization_id=o.id AND m.role='owner' AND m.revoked_at IS NULL
       JOIN agents_platform.accounts a ON a.id=m.account_id
      WHERE o.id=$1
      ORDER BY m.account_id LIMIT 1`,
    [organizationId],
  );
  if (!row.rows[0]) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
  const email = row.rows[0].email?.trim();
  if (!email)
    throw new PlatformError(
      "BILLING_EMAIL_REQUIRED",
      409,
      "The workspace owner needs an email before billing can start",
    );
  await client.ensureAccount({
    tenantId: organizationId,
    name: row.rows[0].name,
    billingEmail: email,
    ownerIssuer: row.rows[0].issuer,
    ownerSubject: row.rows[0].subject,
  });
}

export async function assertAgentsBillingFeature(
  pool: Pool,
  organizationId: string,
  key: string,
): Promise<void> {
  if (!agentsBillingEnforcementEnabled(process.env)) return;
  const client = agentsBillingClient();
  if (!client)
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      "Customer billing is not configured",
    );
  try {
    await ensureAgentsBillingAccount(pool, client, organizationId);
    const snapshot = await client.snapshot(organizationId);
    if (snapshot.features[key] !== true)
      throw new PlatformError(
        "BILLING_PLAN_REQUIRED",
        403,
        "This feature is not included in the current plan",
      );
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      error instanceof Error ? error.message : "Billing service is unavailable",
    );
  }
}

export async function assertAgentsBillingLimit(
  pool: Pool,
  organizationId: string,
  key: string,
  current: number,
  increment = 1,
): Promise<void> {
  if (!agentsBillingEnforcementEnabled(process.env)) return;
  const client = agentsBillingClient();
  if (!client)
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      "Customer billing is not configured",
    );
  try {
    await ensureAgentsBillingAccount(pool, client, organizationId);
    const snapshot = await client.snapshot(organizationId);
    const raw = snapshot.limits[key];
    if (raw == null) return;
    const limit = Number(raw);
    if (!Number.isFinite(limit)) return;
    if (current + increment > limit)
      throw new PlatformError(
        "BILLING_LIMIT_REACHED",
        403,
        `This plan allows ${limit} ${key.replace("limit.", "").replaceAll("_", " ")}`,
      );
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      error instanceof Error ? error.message : "Billing service is unavailable",
    );
  }
}

export async function assertAgentsBillingAccess(
  pool: Pool,
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!agentsBillingEnforcementEnabled(env)) return;
  const client = agentsBillingClient(env);
  if (!client)
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      "Customer billing is not configured",
    );
  try {
    await ensureAgentsBillingAccount(pool, client, organizationId);
    const snapshot = await client.snapshot(organizationId);
    if (snapshot.access === "none")
      throw new PlatformError(
        "BILLING_REQUIRED",
        403,
        "An active Agents plan is required",
      );
    if (snapshot.access === "grace" || snapshot.access === "read_only")
      throw new PlatformError(
        "BILLING_READ_ONLY",
        403,
        "Agents is read-only while billing is past due",
      );
    if (snapshot.features["agents.feature.manage"] !== true)
      throw new PlatformError(
        "BILLING_REQUIRED",
        403,
        "Agents is not included in the current plan",
      );
    const tokens = snapshot.meters.agent_tokens;
    if (
      tokens?.limit != null &&
      BigInt(tokens.used) >= BigInt(tokens.limit)
    )
      throw new PlatformError(
        "BILLING_LIMIT_REACHED",
        403,
        "The monthly agent token allowance is used up",
      );
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      error instanceof Error ? error.message : "Billing service is unavailable",
    );
  }
}
