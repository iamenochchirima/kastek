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

async function ensureAccount(
  pool: Pool,
  client: BillingClient,
  organizationId: string,
): Promise<void> {
  const row = await pool.query<{ name: string; email: string | null }>(
    `SELECT o.name, a.email
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
  });
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
    await ensureAccount(pool, client, organizationId);
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
  } catch (error) {
    if (error instanceof PlatformError) throw error;
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      error instanceof Error ? error.message : "Billing service is unavailable",
    );
  }
}
