import type { FastifyInstance, FastifyRequest } from "fastify";
import type { BillingPlanSummary } from "@kasitek-labs/contracts";
import { PlatformError } from "../../contracts/contracts";
import type { Pool } from "pg";
import {
  agentsBillingClient,
  ensureAgentsBillingAccount,
} from "./billing";

type Scope = { accountId: string; organizationId: string };

function publicPlan(plan: BillingPlanSummary) {
  return {
    key: plan.key,
    name: plan.name,
    description: plan.description,
    product: plan.product,
    currency: plan.currency,
    amountMinor: plan.amountMinor,
    creditsPerPeriod: plan.creditsPerPeriod,
    checkoutReady: plan.checkoutReady,
    entitlements: plan.entitlements
      .filter((item) => item.visibleToCustomer)
      .map((item) => ({
        key: item.key,
        name: item.name,
        description: item.description,
        kind: item.kind === "meter" ? "limit" : item.kind,
        value: item.value,
        unit: item.unit,
        displayGroup: item.displayGroup,
        displayOrder: item.displayOrder,
      })),
  };
}

export function registerBillingRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    publicUrl: string;
    resolveScope(request: FastifyRequest): Promise<Scope>;
  },
): void {
  app.get("/api/public/plans", async (_request, reply) => {
    reply.header(
      "cache-control",
      "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
    );
    const client = agentsBillingClient();
    if (!client) return { configured: false, plans: [] };
    try {
      return { configured: true, plans: (await client.plans()).map(publicPlan) };
    } catch {
      return { configured: false, plans: [] };
    }
  });

  app.get("/api/organizations/:organizationId/billing", async (request) => {
    const scope = await options.resolveScope(request);
    const client = agentsBillingClient();
    if (!client)
      return {
        configured: false,
        account: null,
        invoices: [],
        plans: [],
      };
    await ensureAgentsBillingAccount(
      options.pool,
      client,
      scope.organizationId,
    );
    const account = await client.account(scope.organizationId);
    const accountRecord =
      account.account && typeof account.account === "object"
        ? (account.account as Record<string, unknown>)
        : {};
    const currency =
      typeof accountRecord.currency === "string" ? accountRecord.currency : undefined;
    const [invoices, plans, usage, snapshot] = await Promise.all([
      client.invoices(scope.organizationId),
      client.plans(currency),
      client.usageSummary(scope.organizationId).catch(() => null),
      client.snapshot(scope.organizationId).catch(() => null),
    ]);
    const modelUsage = usage
      ? (
          await options.pool.query<{
            provider: string;
            model: string;
            requests: string;
            input_tokens: string;
            output_tokens: string;
            cost_micros: string;
          }>(
            `SELECT
               COALESCE(r.routes->(CASE WHEN o.kind='compaction' THEN 'compaction' ELSE 'primary' END)->'binding'->>'providerId','unknown') AS provider,
               COALESCE(r.routes->(CASE WHEN o.kind='compaction' THEN 'compaction' ELSE 'primary' END)->'binding'->>'modelId','unknown') AS model,
               count(*)::text AS requests,
               COALESCE(SUM(
                 CASE WHEN o.output->'usage'->>'observed'='true'
                      AND jsonb_typeof(o.output->'usage'->'inputTokens')='number'
                      THEN (o.output->'usage'->>'inputTokens')::bigint ELSE 0 END
               ),0)::text AS input_tokens,
               COALESCE(SUM(
                 CASE WHEN o.output->'usage'->>'observed'='true'
                      AND jsonb_typeof(o.output->'usage'->'outputTokens')='number'
                      THEN (o.output->'usage'->>'outputTokens')::bigint ELSE 0 END
               ),0)::text AS output_tokens,
               COALESCE(SUM(CASE WHEN c.state='settled' THEN c.actual_micros ELSE 0 END),0)::text AS cost_micros
             FROM agents_platform.tasks t
             JOIN agents_platform.operations o
               ON o.task_id=t.id AND o.kind IN ('model','compaction')
             JOIN agents_platform.task_model_routes r ON r.task_id=t.id
             LEFT JOIN agents_platform.model_cost_reservations c
               ON c.operation_id=o.id AND c.task_id=t.id
             WHERE t.organization_id=$1 AND t.product='agents'
               AND o.completed_at >= $2 AND o.completed_at <= $3
             GROUP BY 1,2
             ORDER BY count(*) DESC, model`,
            [
              scope.organizationId,
              String((usage as Record<string, unknown>).from),
              String((usage as Record<string, unknown>).to),
            ],
          )
        ).rows.map((row) => ({
          provider: row.provider,
          model: row.model,
          requests: Number(row.requests),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          costMicros: Number(row.cost_micros),
        }))
      : [];
    return {
      configured: true,
      account,
      invoices,
      plans: plans.map(publicPlan),
      usage,
      snapshot,
      modelUsage,
    };
  });

  app.post("/api/organizations/:organizationId/billing/checkout", async (request) => {
    const scope = await options.resolveScope(request);
    const client = agentsBillingClient();
    if (!client)
      throw new PlatformError("BILLING_UNAVAILABLE", 503, "Customer billing is not configured");
    const body = (request.body ?? {}) as { planKey?: unknown; idempotencyKey?: unknown };
    if (typeof body.planKey !== "string" || !body.planKey.trim())
      throw new PlatformError("BILLING_PLAN_REQUIRED", 400, "Plan key is required");
    if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim())
      throw new PlatformError("BILLING_REQUEST_INVALID", 400, "Checkout idempotency key is required");
    await ensureAgentsBillingAccount(options.pool, client, scope.organizationId);
    const account = await client.account(scope.organizationId);
    const accountRecord =
      account.account && typeof account.account === "object"
        ? (account.account as Record<string, unknown>)
        : {};
    const email =
      typeof accountRecord.billing_email === "string"
        ? accountRecord.billing_email
        : "";
    if (!email) throw new PlatformError("BILLING_EMAIL_REQUIRED", 409, "The billing account has no email");
    const result = await client.checkout({
      tenantId: scope.organizationId,
      planKey: body.planKey.trim(),
      email,
      idempotencyKey: body.idempotencyKey.trim(),
      returnUrl: `${options.publicUrl.replace(/\/+$/, "")}/app/settings?payment=complete`,
    });
    return result;
  });

  app.post(
    "/api/organizations/:organizationId/billing/checkout/:reference/verify",
    async (request) => {
      const scope = await options.resolveScope(request);
      const client = agentsBillingClient();
      if (!client)
        throw new PlatformError("BILLING_UNAVAILABLE", 503, "Customer billing is not configured");
      const reference = (request.params as { reference: string }).reference;
      return client.verifyCheckout(scope.organizationId, reference);
    },
  );
}
