import { BillingClient } from "@kasitek-labs/server-support/billing-client";
import type { TenantContext } from "../context.js";
import { TenantError } from "../error.js";

export function agencyBillingClient(
  context: TenantContext,
): BillingClient | null {
  const url = context.config.billing_service_url;
  const secret = context.config.billing_service_secret;
  const snapshotSecret = context.config.billing_snapshot_secret;
  if (!url || !secret || !snapshotSecret) return null;
  return new BillingClient({ url, secret, snapshotSecret, product: "agency" });
}

async function ensureAccount(
  context: TenantContext,
  workspaceId: string,
): Promise<void> {
  const client = agencyBillingClient(context);
  if (!client) throw new TenantError(503, "Customer billing is not configured");
  const row = await context.pool.query<{
    display_name: string;
    email: string | null;
  }>(
    `SELECT w.display_name, u.email
       FROM workspaces w
       JOIN tenant_user_roles r ON r.role='owner'
       JOIN tenant_users u ON u.id=r.tenant_user_id AND u.workspace_id=w.id
      WHERE w.id=$1
      LIMIT 1`,
    [workspaceId],
  );
  if (!row.rows[0]) throw new TenantError(403, "Workspace owner not found");
  const email = row.rows[0].email?.trim();
  if (!email)
    throw new TenantError(409, "The workspace owner needs an email before billing can start");
  await client.ensureAccount({
    tenantId: workspaceId,
    name: row.rows[0].display_name,
    billingEmail: email,
  });
}

export async function assertAgencyBillingAccess(
  context: TenantContext,
  workspaceId: string,
): Promise<void> {
  if (!context.config.billing_enforcement) return;
  try {
    await ensureAccount(context, workspaceId);
    const snapshot = await agencyBillingClient(context)!.snapshot(workspaceId);
    if (snapshot.access === "none")
      throw new TenantError(403, "An active Agency plan is required");
    if (snapshot.access === "grace" || snapshot.access === "read_only")
      throw new TenantError(403, "Agency is read-only while billing is past due");
    if (snapshot.features["agency.feature.agents"] !== true)
      throw new TenantError(403, "Agency agents are not included in the current plan");
  } catch (error) {
    if (error instanceof TenantError) throw error;
    throw new TenantError(
      503,
      error instanceof Error ? error.message : "Billing service is unavailable",
    );
  }
}

export async function recordAgencyAgentCommand(
  context: TenantContext,
  workspaceId: string,
  requestId: string,
): Promise<void> {
  const client = agencyBillingClient(context);
  if (!client) return;
  try {
    await client.usage({
      tenantId: workspaceId,
      meterKey: "agency_agent_commands",
      quantity: "1",
      sourceType: "agency_agent_command",
      sourceId: requestId,
      idempotencyKey: `agency:command:${requestId}`,
    });
  } catch (error) {
    console.error({
      event: "billing.usage.sync_failed",
      workspaceId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
