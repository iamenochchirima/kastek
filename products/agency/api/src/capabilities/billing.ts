import { randomUUID } from "node:crypto";
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

export async function ensureAgencyBillingAccount(
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
    await ensureAgencyBillingAccount(context, workspaceId);
    const snapshot = await agencyBillingClient(context)!.snapshot(workspaceId);
    if (snapshot.access === "none")
      throw new TenantError(403, "An active Agency plan is required");
    if (snapshot.access === "grace" || snapshot.access === "read_only")
      throw new TenantError(403, "Agency is read-only while billing is past due");
    if (snapshot.features["agency.feature.agents"] !== true)
      throw new TenantError(403, "Agency agents are not included in the current plan");
    const commands = snapshot.meters.agency_agent_commands;
    if (
      commands?.limit != null &&
      BigInt(commands.used) >= BigInt(commands.limit)
    )
      throw new TenantError(403, "The monthly agent command allowance is used up");
  } catch (error) {
    if (error instanceof TenantError) throw error;
    throw new TenantError(
      503,
      error instanceof Error ? error.message : "Billing service is unavailable",
    );
  }
}

export interface AgencyUsageOutboxRow {
  id: string;
  tenant_id: string;
  meter_key: string;
  quantity: string;
  source_type: string;
  source_id: string;
  idempotency_key: string;
  attempts: number;
}

export async function forwardAgencyUsageRow(
  pool: TenantContext["pool"],
  client: BillingClient,
  row: AgencyUsageOutboxRow,
): Promise<boolean> {
  try {
    await client.usage({
      tenantId: row.tenant_id,
      meterKey: row.meter_key,
      quantity: row.quantity,
      sourceType: row.source_type,
      sourceId: row.source_id,
      idempotencyKey: row.idempotency_key,
    });
    await pool.query(
      `UPDATE billing_usage_outbox
          SET delivered_at=now(), attempts=attempts+1, last_error=NULL, updated_at=now()
        WHERE id=$1`,
      [row.id],
    );
    return true;
  } catch (error) {
    const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(row.attempts, 10));
    await pool.query(
      `UPDATE billing_usage_outbox
          SET attempts=attempts+1,
              next_attempt_at=now()+($2::int * interval '1 second'),
              last_error=$3, updated_at=now()
        WHERE id=$1`,
      [
        row.id,
        delaySeconds,
        error instanceof Error ? error.message.slice(0, 1000) : "unknown",
      ],
    );
    return false;
  }
}

export async function recordAgencyAgentCommand(
  context: TenantContext,
  workspaceId: string,
  requestId: string,
): Promise<void> {
  const client = agencyBillingClient(context);
  if (!client) return;
  const idempotencyKey = `agency:command:${requestId}`;
  try {
    await context.pool.query(
      `INSERT INTO billing_usage_outbox(
         id, tenant_id, meter_key, quantity, source_type, source_id, idempotency_key
       ) VALUES($1,$2,'agency_agent_commands',1,'agency_agent_command',$3,$4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [randomUUID(), workspaceId, requestId, idempotencyKey],
    );
    const row = await context.pool.query<AgencyUsageOutboxRow>(
      `SELECT id, tenant_id, meter_key, quantity::text,
              source_type, source_id, idempotency_key, attempts
         FROM billing_usage_outbox
        WHERE idempotency_key=$1 AND delivered_at IS NULL`,
      [idempotencyKey],
    );
    if (row.rows[0]) {
      const delivered = await forwardAgencyUsageRow(
        context.pool,
        client,
        row.rows[0],
      );
      if (!delivered)
        console.error({
          event: "billing.usage.sync_failed",
          workspaceId,
          requestId,
        });
    }
  } catch (error) {
    console.error({
      event: "billing.usage.outbox_failed",
      workspaceId,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}
