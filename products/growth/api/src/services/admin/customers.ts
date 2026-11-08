import type { Pool } from "pg";
import type {
  CustomerOverview,
  CustomerSection,
  CustomerRecord,
  CustomerOperationRequest,
  CustomerOperationReceipt,
} from "@kasitek-labs/contracts";
import { getBillingSummary, billingEnforcementEnabled } from "../billing.js";
import { billingServiceConfig, serviceCredits } from "../billing-service.js";
import { missing, bad, conflict } from "./common.js";
import * as replay from "./webhook-replay.js";
import {
  customerOperationDigest,
  parseCustomerPage,
} from "@kasitek-labs/server-support/admin-customers";
type SectionDraft = Omit<CustomerSection, "source" | "observedAt">;
const section = (value: SectionDraft): CustomerSection => ({
  ...value,
  source: "growth",
  observedAt: value.status === "available" ? new Date().toISOString() : null,
});
const fact = (key: string, value: unknown, label = key) => ({
  key,
  label,
  value: value == null ? null : String(value),
});
export async function customerExists(pool: Pool, id: string) {
  const row = (
    await pool.query(`SELECT id,name FROM "Organization" WHERE id=$1`, [id])
  ).rows[0];
  return row ?? missing("Customer not found");
}
export function customerPage(query: Record<string, unknown>) {
  return parseCustomerPage(query);
}
export async function customerCollection(
  pool: Pool,
  id: string,
  collection: string,
  query: Record<string, unknown>,
): Promise<CustomerSection> {
  await customerExists(pool, id);
  const { limit, cursor } = customerPage(query);
  let records: CustomerRecord[] = [];
  if (collection === "failures") {
    const rows = (
      await pool.query(
        `SELECT d.id,d.status,d."attemptCount",d."eventType",s.status AS "subscriptionState",EXISTS(SELECT 1 FROM "AdminWebhookReplayCommand" c WHERE c."deliveryId"=d.id AND (c.status='awaiting_approval' OR (c."customerId" IS NOT NULL AND c.status='completed' AND c."settledStatus" IS NULL))) AS "replayActive" FROM "PublicApiWebhookDelivery" d JOIN "PublicApiWebhookSubscription" s ON s.id=d."subscriptionId" WHERE s."orgId"=$1 AND d.status='FAILED' AND ($2::text IS NULL OR d.id>$2) ORDER BY d.id LIMIT $3`,
        [id, cursor, limit + 1],
      )
    ).rows;
    records = rows.map((r) => ({
      id: r.id,
      label: r.eventType,
      state: r.status,
      facts: [
        fact("attemptCount", r.attemptCount),
        fact("subscriptionState", r.subscriptionState),
      ],
      actions:
        r.subscriptionState === "ACTIVE" && !r.replayActive
          ? [
              {
                action: "webhook.replay",
                label: "Replay webhook",
                targetId: r.id,
                expected: { status: r.status, attemptCount: r.attemptCount },
              },
            ]
          : [],
    }));
  } else if (collection === "ledger" || collection === "grants" || collection === "reservations") {
    const config = billingServiceConfig(process.env);
    if (!config) throw new Error("Central billing is not configured");
    const credits = await serviceCredits(config, id);
    if (collection === "ledger") {
      const ledger = Array.isArray(credits.ledger) ? credits.ledger as Record<string, unknown>[] : [];
      records = ledger.map((entry) => ({
        id: String(entry.id),
        label: String(entry.type),
        state: "recorded",
        facts: [
          fact("amount", entry.amount),
          fact("balanceAfter", entry.balanceAfter),
          fact("createdAt", entry.createdAt),
        ],
      }));
    } else if (collection === "grants") {
      const grants = Array.isArray(credits.grants) ? credits.grants as Record<string, unknown>[] : [];
      records = grants.map((grant) => ({
        id: String(grant.id),
        label: String(grant.source),
        state: "active",
        facts: [
          fact("remainingAmount", grant.remainingAmount),
          fact("startsAt", grant.startsAt),
          fact("endsAt", grant.endsAt),
        ],
      }));
    } else {
      records = [];
    }
  } else if (collection === "operations") {
    const ids = (
      await pool.query(
        `SELECT "operationId" FROM "AdminWebhookReplayCommand" WHERE "customerId"=$1 AND ($2::text IS NULL OR "operationId">$2) ORDER BY "operationId" LIMIT $3`,
        [id, cursor, limit + 1],
      )
    ).rows;
    records = await Promise.all(
      ids.map(async (r) => {
        const op = await customerReceipt(pool, id, r.operationId);
        return {
          id: op.id,
          label: op.action,
          state: op.status,
          facts: [fact("actorId", op.actorId), fact("reason", op.reason)],
          actions:
            op.status === "awaiting_approval"
              ? [
                  {
                    action: "webhook.replay.approve" as const,
                    label: "Approve replay",
                    targetId: op.id,
                    expected: { status: "awaiting_approval" },
                  },
                ]
              : [],
        };
      }),
    );
  } else if (collection === "deployments")
    return section({
      id: collection,
      title: "Deployments",
      status: "unsupported",
      records: [],
      nextCursor: null,
    });
  else bad("Unsupported customer collection");
  const more = records.length > limit;
  records = records.slice(0, limit);
  return section({
    id: collection,
    title: collection,
    status: "available",
    records,
    nextCursor: more ? records.at(-1)!.id : null,
  });
}
export async function customerOverview(
  pool: Pool,
  id: string,
): Promise<CustomerOverview> {
  const customer = await customerExists(pool, id);
  const sections: SectionDraft[] = [];
  try {
    const summary = await getBillingSummary(pool, id);
    const products = summary.products as Record<string, unknown>[];
    const meters = summary.meters as Record<string, unknown>[];
    sections.push({
      id: "account",
      title: "Plan and entitlements",
      status: "available",
      nextCursor: null,
      records: products.map((p) => ({
        id: String(p.key),
        label: String(p.name),
        state: String(p.subscriptionStatus ?? "no_subscription"),
        facts: [
          fact("plan", p.planName),
          fact("access", p.hasAccess),
          fact("currentPeriodStart", p.currentPeriodStart),
          fact("currentPeriodEnd", p.currentPeriodEnd),
          {
            ...fact("billingEnforcement", billingEnforcementEnabled()),
            enforced: billingEnforcementEnabled(),
          },
        ],
      })),
    });
    const features = summary.features as Record<string, unknown>[];
    sections.push({
      id: "entitlements",
      title: "Effective entitlements",
      status: "available",
      nextCursor: null,
      records: features.map((f) => ({
        id: String(f.key),
        label: String(f.name),
        state: f.enabled ? "enabled" : "disabled",
        facts: [
          {
            ...fact("enabled", f.enabled),
            enforced: billingEnforcementEnabled(),
          },
        ],
      })),
    });
    sections.push({
      id: "usage",
      title: "Usage and limits",
      status: "available",
      nextCursor: null,
      records: meters.map((m) => ({
        id: String(m.key),
        label: String(m.name),
        state: "measured",
        facts: [
          { ...fact("used", m.used), period: "current UTC calendar month" },
          { ...fact("configuredLimit", m.configuredLimit), enforced: false },
          { ...fact("limit", m.limit), enforced: billingEnforcementEnabled() },
        ],
      })),
    });
  } catch {
    sections.push(
      {
        id: "account",
        title: "Plan and entitlements",
        status: "unavailable",
        records: [],
        nextCursor: null,
      },
      {
        id: "usage",
        title: "Usage and limits",
        status: "unavailable",
        records: [],
        nextCursor: null,
      },
    );
  }
  try {
    const config = billingServiceConfig(process.env);
    if (!config) throw new Error("Central billing is not configured");
    const credits = await serviceCredits(config, id);
    const account = credits.credits as Record<string, unknown> | undefined;
    sections.push({
      id: "credits",
      title: "AI usage",
      status: "available",
      nextCursor: null,
      records: account
        ? [
            {
              id,
              label: "Central billing AI usage (micro-USD)",
              state: "persisted",
              facts: [
                fact("balance", account.balance),
                fact("reserved", account.reserved),
                fact("available", account.available),
              ],
            },
          ]
        : [],
    });
  } catch {
    sections.push({
      id: "credits",
      title: "AI usage",
      status: "unavailable",
      nextCursor: null,
      records: [],
    });
  }
  for (const collection of [
    "failures",
    "operations",
    "grants",
    "ledger",
    "reservations",
    "deployments",
  ]) {
    try {
      sections.push(await customerCollection(pool, id, collection, {}));
    } catch {
      sections.push({
        id: collection,
        title: collection,
        status: "unavailable",
        nextCursor: null,
        records: [],
      });
    }
  }
  return {
    customer: { product: "growth", id, name: customer.name, state: "present" },
    observedAt: new Date().toISOString(),
    sections: sections.map(section),
    relationships: [],
  };
}
export async function customerReceipt(
  pool: Pool,
  customerId: string,
  id: string,
): Promise<CustomerOperationReceipt> {
  const r =
    (
      await pool.query(
        `SELECT c.*,d.status AS "deliveryStatus",a.id AS "approvalId",a."actorId" AS "approvalActorId",a.reason AS "approvalReason",a."createdAt" AS "approvalCreatedAt" FROM "AdminWebhookReplayCommand" c LEFT JOIN "AdminCustomerReplayApproval" a ON a."commandId"=c.id AND a.id=$1 JOIN "PublicApiWebhookDelivery" d ON d.id=c."deliveryId" JOIN "PublicApiWebhookSubscription" s ON s.id=d."subscriptionId" WHERE (c."operationId"=$1 OR a.id=$1) AND c."customerId"=$2 AND s."orgId"=$2`,
        [id, customerId],
      )
    ).rows[0] ?? missing("Operation not found");
  return {
    id: r.approvalId ?? r.operationId,
    customer: { product: "growth", id: customerId },
    action: r.approvalId ? "webhook.replay.approve" : "webhook.replay",
    targetId: r.approvalId ? r.operationId : r.deliveryId,
    actorId: r.approvalActorId ?? r.actorId,
    reason: r.approvalReason ?? r.reason,
    status:
      r.status === "awaiting_approval"
        ? "awaiting_approval"
        : r.status === "failed"
          ? "rejected"
          : (r.settledStatus ??
            (r.deliveryStatus === "DELIVERED"
              ? "confirmed"
              : r.deliveryStatus === "FAILED"
                ? "failed"
                : "pending")),
    createdAt: new Date(r.approvalCreatedAt ?? r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    code: r.error ? "replay_precondition_failed" : null,
    sourceOperationId: r.id,
  };
}
export async function previewCustomerOperation(
  pool: Pool,
  customerId: string,
  request: CustomerOperationRequest,
  actorId?: string,
) {
  await customerExists(pool, customerId);
  if (request.action === "webhook.replay.approve") {
    const receipt = await customerReceipt(pool, customerId, request.targetId);
    if (actorId === receipt.actorId)
      conflict("A second, distinct operator approval is required");
    if (
      receipt.status !== "awaiting_approval" ||
      request.expected.status !== "awaiting_approval"
    )
      conflict("Replay is not awaiting approval");
  } else if (request.action === "webhook.replay") {
    const r =
      (
        await pool.query(
          `SELECT d.status,d."attemptCount",s.status AS "subscriptionState" FROM "PublicApiWebhookDelivery" d JOIN "PublicApiWebhookSubscription" s ON s.id=d."subscriptionId" WHERE d.id=$1 AND s."orgId"=$2`,
          [request.targetId, customerId],
        )
      ).rows[0] ?? missing("Webhook delivery not found");
    if (
      request.expected.status !== "FAILED" ||
      r.status !== "FAILED" ||
      request.expected.attemptCount !== r.attemptCount ||
      r.subscriptionState !== "ACTIVE"
    )
      conflict("Webhook delivery changed; refresh customer");
    if (
      (
        await pool.query(
          `SELECT id FROM "AdminWebhookReplayCommand" WHERE "deliveryId"=$1 AND (status='awaiting_approval' OR ("customerId" IS NOT NULL AND status='completed' AND "settledStatus" IS NULL)) LIMIT 1`,
          [request.targetId],
        )
      ).rowCount
    )
      conflict("A replay operation is already active for this delivery");
  } else bad("Unsupported Growth customer action");
  return {
    customer: { product: "growth" as const, id: customerId },
    action: request.action,
    targetId: request.targetId,
    impact:
      "Requeue one failed outgoing webhook after two distinct operator approvals",
    eligible: true,
  };
}
export async function executeCustomerOperation(
  pool: Pool,
  customerId: string,
  actorId: string,
  request: CustomerOperationRequest,
) {
  if (request.action !== "webhook.replay")
    bad("Use the scoped approval endpoint");
  const digest = customerOperationDigest(
    actorId,
    "growth",
    customerId,
    request,
  );
  const existing = (
    await pool.query(
      `SELECT "operationId","requestDigest" FROM "AdminWebhookReplayCommand" WHERE "operationId"=$1`,
      [request.operationId],
    )
  ).rows[0];
  if (existing) {
    if (existing.requestDigest !== digest)
      conflict("Operation ID has different request");
    return customerReceipt(pool, customerId, request.operationId);
  }
  await previewCustomerOperation(pool, customerId, request);
  await replay.createReplay(pool, `customer:${request.operationId}`, actorId, {
    deliveryId: request.targetId,
    expectedStatus: request.expected.status,
    expectedAttemptCount: request.expected.attemptCount,
    customerId,
    operationId: request.operationId,
    requestDigest: digest,
    reason: request.reason,
  });
  return customerReceipt(pool, customerId, request.operationId);
}
export async function approveCustomerOperation(
  pool: Pool,
  customerId: string,
  id: string,
  actorId: string,
  request: CustomerOperationRequest,
) {
  const receipt = await customerReceipt(pool, customerId, id);
  await replay.approveReplay(pool, receipt.sourceOperationId!, actorId, {
    customerId,
    operationId: request.operationId,
    digest: customerOperationDigest(actorId, "growth", customerId, request),
    reason: request.reason,
  });
  return customerReceipt(pool, customerId, request.operationId);
}
