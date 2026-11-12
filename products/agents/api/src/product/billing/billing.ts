import type { Pool } from "pg";
import { BillingClient } from "@kasitek-labs/server-support/billing-client";
import type { BillingEntitlementSnapshot } from "@kasitek-labs/contracts";
import { PlatformError } from "../../contracts/contracts";

/** Plans without a paid entitlement. They keep free managed models only. */
export const freePlanKeys: ReadonlySet<string> = new Set([
  "agents-free",
  "growth-free",
  "agency-free",
]);

export function billingPaidPlan(snapshot: BillingEntitlementSnapshot): boolean {
  return snapshot.plan !== null && !freePlanKeys.has(snapshot.plan.key);
}

/** The managed catalogue stays open while AI credits remain; exhausted workspaces keep free models. */
export function billingManagedCatalogueAllowed(snapshot: BillingEntitlementSnapshot): boolean {
  return BigInt(snapshot.credits.available) > 0n;
}

/** Read-only projection for the model picker. Admission remains the enforcement point, so a billing outage does not hide models. */
export async function agentsManagedModelCatalogueAllowed(
  pool: Pool,
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!agentsBillingEnforcementEnabled(env)) return true;
  try {
    return billingManagedCatalogueAllowed(await agentsBillingSnapshot(pool, organizationId, env));
  } catch {
    return true;
  }
}

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

async function agentsBillingSnapshot(
  pool: Pool,
  organizationId: string,
  env: NodeJS.ProcessEnv,
): Promise<BillingEntitlementSnapshot> {
  const client = agentsBillingClient(env);
  if (!client)
    throw new PlatformError(
      "BILLING_UNAVAILABLE",
      503,
      "Customer billing is not configured",
    );
  try {
    await ensureAgentsBillingAccount(pool, client, organizationId);
    return await client.snapshot(organizationId);
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
): Promise<BillingEntitlementSnapshot | null> {
  if (!agentsBillingEnforcementEnabled(env)) return null;
  const snapshot = await agentsBillingSnapshot(pool, organizationId, env);
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
  return snapshot;
}

/** The allowance gates managed models only; customer-supplied keys keep working at zero. */
export function assertManagedModelAllowance(
  snapshot: BillingEntitlementSnapshot | null,
  custody: string | undefined,
): void {
  if (!snapshot || custody !== "platform_managed") return;
  if (BigInt(snapshot.credits.available) > 0n) return;
  throw new PlatformError(
    "BILLING_AI_ALLOWANCE_EXHAUSTED",
    403,
    "The monthly AI usage allowance is used up. Upgrade the plan, add your own provider, or wait for the next billing period.",
  );
}

/** Customer-supplied provider keys are a paid-plan capability. Credits are not required to add one. */
export async function assertAgentsPaidPlan(
  pool: Pool,
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!agentsBillingEnforcementEnabled(env)) return;
  const snapshot = await agentsBillingSnapshot(pool, organizationId, env);
  if (!billingPaidPlan(snapshot))
    throw new PlatformError(
      "BILLING_PLAN_REQUIRED",
      403,
      "Bringing your own model provider is available on a paid plan",
    );
}
