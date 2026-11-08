import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import type {
  BillingProduct,
  BillingUsageEventInput,
} from "@kasitek-labs/contracts";
import type { BillingConfig } from "./config.js";
import {
  ensureAccount,
  getAccountById,
  getAccountForTenant,
  linkTenant,
} from "./accounts.js";
import {
  adminCatalog,
  adminPlanDetail,
  clonePlan,
  createPlanDraft,
  createPlanVersionDraft,
  getLatestPlanVersion,
  getPlanDetails,
  getPlanVersionById,
  getPlanEntitlements,
  listPlans,
  parseBoolean,
  parseCapabilityKind,
  parseImplementationStatus,
  parseOptionalWire,
  parsePlanEntitlements,
  parseProduct,
  parseTaxRate,
  parseValueType,
  publishPlanVersion,
  replacePlanEntitlements,
  schedulePlanVersion,
  retirePlanVersion,
  updatePlanVersionDraft,
  upsertCapability,
  upsertProduct,
} from "./catalog.js";
import {
  createCheckout,
  verifyCheckout,
} from "./checkouts.js";
import {
  getCreditSummary,
  grantCredits,
  listCreditLedger,
  revokeCreditGrant,
  setCreditBalance,
} from "./credits.js";
import {
  accountSummary,
  parseTenantQuery,
  recordUsage,
  signedEntitlementSnapshot,
  usageSummary,
} from "./entitlements.js";
import { listInvoices } from "./invoices.js";
import {
  assignPlan,
  cancelSubscription,
  endTrialSubscription,
  extendTrialSubscription,
  reactivateSubscription,
  startTrial,
  trialEligibility,
  recordIssue,
} from "./subscriptions.js";
import { providerFromConfig } from "./paystack.js";
import { handleWebhook } from "./webhooks.js";
import {
  audit,
  requireAdminAuthority,
  requireProductAuthority,
  type RawBodyRequest,
} from "./auth.js";
import {
  arrayValue,
  bad,
  bigValue,
  dateValue,
  HttpError,
  jsonObject,
  missing,
  objectValue,
  optionalText,
  text,
} from "./util.js";

export async function buildApi(
  pool: Pool,
  config: BillingConfig,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url?.split("?")[0],
          };
        },
      },
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers.x-kasitek-admin-authority",
        "req.headers.x-kasitek-billing-authority",
        "req.headers.x-paystack-signature",
      ],
    },
    bodyLimit: 262_144,
    trustProxy: false,
  });

  app.setErrorHandler((error, request, reply) => {
    const status =
      error instanceof HttpError
        ? error.statusCode
        : (error as { statusCode?: number }).statusCode ?? 500;
    const code =
      error instanceof HttpError ? error.code : status >= 500 ? "internal_error" : "bad_request";
    if (status >= 500)
      request.log.error(
        { event: "request.failed", route: request.url.split("?")[0], status, code },
        error instanceof Error ? error.message : "unknown",
      );
    reply.code(status).send({
      error:
        status >= 500
          ? "Billing service unavailable"
          : error instanceof Error
            ? error.message
            : "Request failed",
      code,
    });
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 262_144 },
    (request, body, done) => {
      const raw = String(body);
      (request as RawBodyRequest).rawBody = raw;
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(new HttpError(400, "Invalid JSON", "bad_request"), undefined);
      }
    },
  );

  const productProvider = () => providerFromConfig(config);

  async function productRequest(
    request: RawBodyRequest,
  ): Promise<{ product: BillingProduct; body: Record<string, unknown> }> {
    const authority = await requireProductAuthority(request, pool, config);
    const body = request.body == null ? {} : objectValue(request.body);
    const requested = body.product ?? (request.query as Record<string, unknown> | undefined)?.product;
    if (requested !== undefined && requested !== authority.product)
      bad("Request product does not match billing authority");
    return { product: authority.product, body };
  }

  async function adminRequest(
    request: RawBodyRequest,
    capability?: "admin:read" | "admin:write",
  ): Promise<{ actor: { id: string; role: string }; body: Record<string, unknown> }> {
    const actor = await requireAdminAuthority(request, pool, config, capability);
    const body = request.body == null ? {} : objectValue(request.body);
    return { actor, body };
  }

  function tenantInput(body: Record<string, unknown>, product: BillingProduct) {
    return {
      product,
      tenantId: text(body.tenantId, "Tenant id", 256),
    };
  }

  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await pool.query("SELECT 1 FROM billing.accounts LIMIT 1");
      await pool.query("SELECT 1 FROM billing.plans LIMIT 1");
      await pool.query("SELECT 1 FROM billing.webhook_events LIMIT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  // ─── Product-facing API ─────────────────────────────────

  app.post("/internal/accounts/ensure", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const result = await ensureAccount(
      pool,
      {
        product,
        tenantId: text(body.tenantId, "Tenant id", 256),
        name: text(body.name, "Account name", 200),
        billingEmail: text(body.billingEmail, "Billing email", 320),
        ownerIssuer: optionalText(body.ownerIssuer, 255),
        ownerSubject: optionalText(body.ownerSubject, 255),
        currency: optionalText(body.currency, 3) ?? undefined,
        metadata: jsonObject(body.metadata),
      },
      config,
    );
    return result;
  });

  app.get("/internal/entitlements", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = parseTenantQuery(request.query);
    if (query.product !== product) bad("Request product does not match authority");
    return signedEntitlementSnapshot(pool, product, query.tenantId, config);
  });

  app.post("/internal/entitlements", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const query = parseTenantQuery(body);
    if (query.product !== product) bad("Request product does not match authority");
    return signedEntitlementSnapshot(pool, product, query.tenantId, config);
  });

  app.post("/internal/usage", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const tenantId = text(body.tenantId, "Tenant id", 256);
    const input: BillingUsageEventInput = {
      product,
      tenantId,
      meterKey: text(body.meterKey, "Meter key", 120),
      quantity: bigValue(body.quantity, "Usage quantity", 0n).toString(),
      occurredAt: body.occurredAt ? dateValue(body.occurredAt, "Occurred at").toISOString() : undefined,
      sourceType: optionalText(body.sourceType, 120),
      sourceId: optionalText(body.sourceId, 200),
      idempotencyKey: text(body.idempotencyKey, "Usage idempotency key", 240),
      providerCostMinor:
        body.providerCostMinor == null
          ? null
          : bigValue(body.providerCostMinor, "Provider cost", 0n).toString(),
      currency: optionalText(body.currency, 3),
      metadata: jsonObject(body.metadata),
    };
    return recordUsage(pool, product, tenantId, input);
  });

  app.get("/internal/usage", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = parseTenantQuery(request.query);
    if (query.product !== product) bad("Request product does not match authority");
    const raw = request.query as { from?: unknown; to?: unknown };
    const from = raw.from ? dateValue(raw.from, "Usage range start") : undefined;
    const to = raw.to ? dateValue(raw.to, "Usage range end") : undefined;
    const { account } = await getAccountForTenant(pool, product, query.tenantId);
    return usageSummary(pool, account.id, product, { from, to });
  });

  app.get("/internal/trials/eligibility", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = parseTenantQuery(request.query);
    if (query.product !== product) bad("Request product does not match authority");
    const { account } = await getAccountForTenant(pool, product, query.tenantId);
    return trialEligibility(pool, config, account.id, product);
  });

  app.post("/internal/trials", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const tenant = parseTenantQuery({ product, tenantId: body.tenantId });
    const { account } = await getAccountForTenant(pool, product, tenant.tenantId);
    return startTrial(pool, config, account.id, product);
  });

  app.get("/internal/plans", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = (request.query ?? {}) as { currency?: string };
    const currency =
      typeof query.currency === "string" && query.currency.trim()
        ? text(query.currency, "Plan currency", 3).toUpperCase()
        : undefined;
    return { plans: await listPlans(pool, product, currency) };
  });

  app.get("/internal/plans/:planKey", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = (request.query ?? {}) as { currency?: string };
    const currency =
      typeof query.currency === "string" && query.currency.trim()
        ? text(query.currency, "Plan currency", 3).toUpperCase()
        : undefined;
    const plan = await getPlanDetails(
      pool,
      text((request.params as { planKey: string }).planKey, "Plan key", 80),
      currency,
    );
    if (plan.product !== product) missing("Plan not found");
    return plan;
  });

  app.post("/internal/checkout", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    return createCheckout(pool, config, productProvider(), {
      product,
      tenantId: text(body.tenantId, "Tenant id", 256),
      planKey: text(body.planKey, "Plan key", 80),
      email: text(body.email, "Checkout email", 320),
      idempotencyKey: text(body.idempotencyKey, "Checkout idempotency key", 128),
      returnUrl: text(body.returnUrl, "Checkout return URL", 2048),
    });
  });

  app.post("/internal/checkout/:reference/verify", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    return verifyCheckout(pool, config, productProvider(), {
      product,
      tenantId: text(body.tenantId, "Tenant id", 256),
      reference: text((request.params as { reference: string }).reference, "Checkout reference", 256),
    });
  });

  app.get("/internal/account", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = parseTenantQuery(request.query);
    if (query.product !== product) bad("Request product does not match authority");
    const { account } = await getAccountForTenant(pool, product, query.tenantId);
    return accountSummary(pool, account.id);
  });

  app.get("/internal/invoices", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = parseTenantQuery(request.query);
    if (query.product !== product) bad("Request product does not match authority");
    const { account } = await getAccountForTenant(pool, product, query.tenantId);
    return { invoices: await listInvoices(pool, account.id) };
  });

  app.get("/internal/credits", async (request) => {
    const { product } = await productRequest(request as RawBodyRequest);
    const query = parseTenantQuery(request.query);
    if (query.product !== product) bad("Request product does not match authority");
    const { account } = await getAccountForTenant(pool, product, query.tenantId);
    const grants = await pool.query(
      `SELECT g.id, g.source, g.amount::text, g.remaining::text,
              g.starts_at, g.ends_at, g.reference
         FROM billing.credit_grants g
         JOIN billing.credit_accounts c ON c.id=g.account_id
        WHERE c.billing_account_id=$1
        ORDER BY g.created_at DESC LIMIT 100`,
      [account.id],
    );
    return {
      credits: await getCreditSummary(pool, account.id),
      grants: grants.rows.map((row) => ({
        id: row.id,
        source: row.source,
        amount: Number(row.amount),
        remainingAmount: Number(row.remaining),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        reference: row.reference,
      })),
      ledger: await listCreditLedger(pool, account.id, 100),
    };
  });

  app.post("/internal/credits/grant", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const tenant = parseTenantQuery({ product, tenantId: body.tenantId });
    const { account } = await getAccountForTenant(pool, product, tenant.tenantId);
    const source = String(body.source ?? "").toUpperCase();
    if (!["TRIAL", "PROMOTION", "MIGRATION"].includes(source))
      bad("Product credit source must be TRIAL, PROMOTION, or MIGRATION");
    const grant = await grantCredits(pool, {
      billingAccountId: account.id,
      product,
      source: source as "TRIAL" | "PROMOTION" | "MIGRATION",
      amount: bigValue(body.amount, "Credit amount", 1n),
      startsAt: body.startsAt ? dateValue(body.startsAt, "Grant start") : new Date(),
      endsAt: body.endsAt ? dateValue(body.endsAt, "Grant end") : null,
      reference: optionalText(body.reference, 240),
      idempotencyKey: text(body.idempotencyKey, "Credit idempotency key", 240),
      metadata: jsonObject(body.metadata),
    });
    return {
      grantId: grant.grantId,
      balance: grant.balance.toString(),
      replayed: grant.replayed,
    };
  });

  app.post("/internal/credits/revoke", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const tenant = parseTenantQuery({ product, tenantId: body.tenantId });
    const { account } = await getAccountForTenant(pool, product, tenant.tenantId);
    const grantId = text(body.grantId, "Credit grant id", 120);
    const owned = await pool.query(
      `SELECT 1 FROM billing.credit_grants g
         JOIN billing.credit_accounts c ON c.id=g.account_id
        WHERE g.id=$1 AND c.billing_account_id=$2`,
      [grantId, account.id],
    );
    if (!owned.rowCount) missing("Credit grant not found");
    return revokeCreditGrant(
      pool,
      grantId,
      text(body.reason, "Revocation reason", 500),
      text(body.idempotencyKey, "Revocation idempotency key", 240),
    );
  });

  app.post("/internal/subscriptions/:id/cancel", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const tenant = tenantInput(body, product);
    const { account } = await getAccountForTenant(pool, product, tenant.tenantId);
    return cancelSubscription(
      pool,
      config.paystack ? productProvider() : null,
      account.id,
      product,
      text((request.params as { id: string }).id, "Subscription id", 120),
    );
  });

  app.post("/internal/subscriptions/:id/reactivate", async (request) => {
    const { product, body } = await productRequest(request as RawBodyRequest);
    const tenant = tenantInput(body, product);
    const { account } = await getAccountForTenant(pool, product, tenant.tenantId);
    return reactivateSubscription(
      pool,
      config.paystack ? productProvider() : null,
      account.id,
      product,
      text((request.params as { id: string }).id, "Subscription id", 120),
    );
  });

  // ─── Admin API ──────────────────────────────────────────

  app.get("/admin/catalog", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    return adminCatalog(pool);
  });

  app.post("/admin/products", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const product = await upsertProduct(pool, {
      key: text(body.key, "Product key", 80),
      name: text(body.name, "Product name", 120),
      description: optionalText(body.description, 2000),
      active: parseBoolean(body.active, true),
    });
    await audit(pool, actor.id, "product.upsert", "product", String(body.key), body);
    return product;
  });

  app.post("/admin/capabilities", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const capability = await upsertCapability(pool, {
      key: text(body.key, "Capability key", 120),
      product: parseProduct(body.product),
      name: text(body.name, "Capability name", 120),
      description: optionalText(body.description, 2000),
      kind: parseCapabilityKind(body.kind),
      unit: optionalText(body.unit, 80),
      valueType: parseValueType(body.valueType ?? "boolean"),
      displayGroup: optionalText(body.displayGroup, 120),
      displayOrder: Number(body.displayOrder ?? 0),
      visibleToCustomer: parseBoolean(body.visibleToCustomer, true),
      implementationStatus: parseImplementationStatus(body.implementationStatus ?? "implemented"),
      creditCostPerUnit: parseOptionalWire(body.creditCostPerUnit, "Credit cost per unit"),
      creditCostMinimum: parseOptionalWire(body.creditCostMinimum, "Minimum credit cost") ?? "0",
      active: parseBoolean(body.active, true),
    });
    await audit(pool, actor.id, "capability.upsert", "capability", String(body.key), body);
    return capability;
  });

  app.get("/admin/plans/:planKey", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    return adminPlanDetail(
      pool,
      text((request.params as { planKey: string }).planKey, "Plan key", 80),
    );
  });

  app.post("/admin/plans", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const plan = await createPlanDraft(pool, {
      product: parseProduct(body.product),
      key: text(body.key, "Plan key", 80),
      name: text(body.name, "Plan name", 120),
      description: optionalText(body.description, 2000),
      amountMinor: bigValue(body.amountMinor, "Plan amount", 0n).toString(),
      currency: text(body.currency, "Plan currency", 3).toUpperCase(),
      taxInclusive: parseBoolean(body.taxInclusive, true),
      taxRateBps: parseTaxRate(body.taxRateBps ?? config.taxRateBps),
      creditsPerPeriod: parseOptionalWire(body.creditsPerPeriod, "Plan credits"),
      paystackPlanCode: optionalText(body.paystackPlanCode, 120),
      entitlements:
        body.entitlements == null ? [] : parsePlanEntitlements(body.entitlements),
    });
    await audit(pool, actor.id, "plan.draft.create", "plan", plan.key, body);
    return plan;
  });

  app.post("/admin/plans/:planKey/versions", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const planKey = text((request.params as { planKey: string }).planKey, "Plan key", 80);
    const plan = await createPlanVersionDraft(pool, planKey, {
      amountMinor:
        body.amountMinor == null
          ? undefined
          : bigValue(body.amountMinor, "Plan amount", 0n).toString(),
      currency:
        body.currency == null
          ? undefined
          : text(body.currency, "Plan currency", 3).toUpperCase(),
      taxInclusive:
        body.taxInclusive == null ? undefined : parseBoolean(body.taxInclusive, true),
      taxRateBps:
        body.taxRateBps == null ? undefined : parseTaxRate(body.taxRateBps),
      creditsPerPeriod:
        body.creditsPerPeriod === undefined
          ? undefined
          : parseOptionalWire(body.creditsPerPeriod, "Plan credits"),
      paystackPlanCode:
        body.paystackPlanCode === undefined
          ? undefined
          : optionalText(body.paystackPlanCode, 120),
      notes: optionalText(body.notes, 2000),
      entitlements:
        body.entitlements == null ? undefined : parsePlanEntitlements(body.entitlements),
    });
    await audit(pool, actor.id, "plan.version.create", "plan", planKey, body);
    return plan;
  });

  app.put("/admin/plan-versions/:versionId", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const versionId = text(
      (request.params as { versionId: string }).versionId,
      "Plan version id",
      120,
    );
    const before = await getPlanVersionById(pool, versionId).catch(() => null);
    const plan = await updatePlanVersionDraft(pool, versionId, {
      amountMinor:
        body.amountMinor == null
          ? undefined
          : bigValue(body.amountMinor, "Plan amount", 0n).toString(),
      currency:
        body.currency == null
          ? undefined
          : text(body.currency, "Plan currency", 3).toUpperCase(),
      taxInclusive:
        body.taxInclusive == null ? undefined : parseBoolean(body.taxInclusive, true),
      taxRateBps:
        body.taxRateBps == null ? undefined : parseTaxRate(body.taxRateBps),
      creditsPerPeriod:
        body.creditsPerPeriod === undefined
          ? undefined
          : parseOptionalWire(body.creditsPerPeriod, "Plan credits"),
      paystackPlanCode:
        body.paystackPlanCode === undefined
          ? undefined
          : optionalText(body.paystackPlanCode, 120),
      notes: body.notes === undefined ? undefined : optionalText(body.notes, 2000),
      effectiveFrom: body.effectiveFrom
        ? dateValue(body.effectiveFrom, "Effective from")
        : undefined,
    });
    await audit(pool, actor.id, "plan.version.update", "plan_version", versionId, {
      request: body,
      before,
      after: plan,
    });
    return plan;
  });

  app.post("/admin/plan-versions/:versionId/schedule", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const versionId = text(
      (request.params as { versionId: string }).versionId,
      "Plan version id",
      120,
    );
    const before = await getPlanVersionById(pool, versionId).catch(() => null);
    const plan = await schedulePlanVersion(
      pool,
      versionId,
      dateValue(body.effectiveFrom, "Effective from"),
      actor.id,
    );
    await audit(pool, actor.id, "plan.version.schedule", "plan_version", versionId, {
      request: body,
      before,
      after: plan,
    });
    return plan;
  });

  app.post("/admin/plan-versions/:versionId/publish", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const versionId = text(
      (request.params as { versionId: string }).versionId,
      "Plan version id",
      120,
    );
    const before = await getPlanVersionById(pool, versionId).catch(() => null);
    const plan = await publishPlanVersion(pool, versionId, actor.id);
    await audit(pool, actor.id, "plan.version.publish", "plan_version", versionId, {
      request: body,
      before,
      after: plan,
    });
    return plan;
  });

  app.post("/admin/plan-versions/:versionId/retire", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const versionId = text(
      (request.params as { versionId: string }).versionId,
      "Plan version id",
      120,
    );
    const before = await getPlanVersionById(pool, versionId).catch(() => null);
    const result = await retirePlanVersion(pool, versionId);
    await audit(pool, actor.id, "plan.version.retire", "plan_version", versionId, {
      request: body,
      before,
      after: result,
    });
    return result;
  });

  app.post("/admin/plans/:planKey/clone", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const planKey = text((request.params as { planKey: string }).planKey, "Plan key", 80);
    const plan = await clonePlan(pool, planKey, {
      key: text(body.key, "New plan key", 80),
      name: text(body.name, "New plan name", 120),
    });
    await audit(pool, actor.id, "plan.clone", "plan", plan.key, body);
    return plan;
  });

  app.post("/admin/plans/:planKey/entitlement", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const planKey = text((request.params as { planKey: string }).planKey, "Plan key", 80);
    const version = await getLatestPlanVersion(pool, planKey);
    if (version.status !== "draft" && version.status !== "scheduled")
      bad("Only draft or scheduled plan versions can be edited");
    const key = text(body.key, "Entitlement key", 120);
    const metadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata
        : {};
    await pool.query(
      `INSERT INTO billing.plan_entitlements(id, plan_version_id, key, value, metadata)
       VALUES('ple_' || gen_random_uuid()::text,$1,$2,$3,$4)
       ON CONFLICT (plan_version_id, key) DO UPDATE SET
         value=EXCLUDED.value, metadata=EXCLUDED.metadata, updated_at=now()`,
      [version.id, key, JSON.stringify(body.value), JSON.stringify(metadata)],
    );
    await audit(pool, actor.id, "plan.entitlement.upsert", "plan", planKey, body);
    return { updated: true, planKey, planVersion: version.version, key };
  });

  app.put("/admin/plans/:planKey/entitlements", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const planKey = text((request.params as { planKey: string }).planKey, "Plan key", 80);
    const version = await getLatestPlanVersion(pool, planKey);
    await replacePlanEntitlements(
      pool,
      version.id,
      parsePlanEntitlements(body.entitlements),
    );
    await audit(pool, actor.id, "plan.entitlements.replace", "plan", planKey, body);
    return { updated: true, planKey, planVersion: version.version };
  });

  app.put("/admin/plan-versions/:versionId/entitlements", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const versionId = text(
      (request.params as { versionId: string }).versionId,
      "Plan version id",
      120,
    );
    await replacePlanEntitlements(
      pool,
      versionId,
      parsePlanEntitlements(body.entitlements),
    );
    await audit(pool, actor.id, "plan.entitlements.replace", "plan_version", versionId, body);
    return { updated: true };
  });

  app.post("/admin/accounts", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const product = parseProduct(body.product);
    const result = await ensureAccount(
      pool,
      {
        product,
        tenantId: text(body.tenantId, "Tenant id", 256),
        name: text(body.name, "Account name", 200),
        billingEmail: text(body.billingEmail, "Billing email", 320),
        ownerIssuer: optionalText(body.ownerIssuer, 255),
        ownerSubject: optionalText(body.ownerSubject, 255),
        currency: optionalText(body.currency, 3) ?? undefined,
        metadata: jsonObject(body.metadata),
      },
      config,
    );
    await audit(pool, actor.id, "account.ensure", "billing_account", result.accountId, body);
    return result;
  });

  app.post("/admin/accounts/:id/links", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const accountId = text((request.params as { id: string }).id, "Account id", 120);
    const result = await linkTenant(pool, {
      accountId,
      product: parseProduct(body.product),
      tenantId: text(body.tenantId, "Tenant id", 256),
      role: body.role === "member" ? "member" : "payer",
    });
    await audit(pool, actor.id, "account.link", "billing_account", accountId, body);
    return result;
  });

  app.post("/admin/accounts/:id/grants", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const accountId = text((request.params as { id: string }).id, "Account id", 120);
    await getAccountById(pool, accountId);
    const key = text(body.key, "Grant key", 120);
    const startsAt = body.startsAt ? dateValue(body.startsAt, "Grant start") : new Date();
    const endsAt = body.endsAt ? dateValue(body.endsAt, "Grant end") : null;
    if (endsAt && endsAt <= startsAt) bad("Grant expiry must be after its start");
    await pool.query(
      `INSERT INTO billing.account_grants(
         id, billing_account_id, key, value, source, starts_at, ends_at, reason, created_by
       ) VALUES('grt_' || gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        accountId,
        key,
        JSON.stringify(body.value),
        body.source === "TRIAL" || body.source === "MIGRATION" || body.source === "PROMOTION"
          ? body.source
          : "MANUAL",
        startsAt,
        endsAt,
        optionalText(body.reason, 500),
        actor.id,
      ],
    );
    await pool.query(
      `UPDATE billing.accounts SET entitlements_revision=entitlements_revision+1, updated_at=now() WHERE id=$1`,
      [accountId],
    );
    await audit(pool, actor.id, "account.grant.create", "billing_account", accountId, body);
    return { created: true };
  });

  app.post("/admin/accounts/:id/credits/grant", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const accountId = text((request.params as { id: string }).id, "Account id", 120);
    const account = await getAccountById(pool, accountId);
    const source = String(body.source ?? "ADJUSTMENT").toUpperCase();
    if (
      !["PLAN", "TRIAL", "PURCHASE", "REFERRAL", "MIGRATION", "PROMOTION", "ADJUSTMENT"].includes(
        source,
      )
    )
      bad("Credit source is invalid");
    const result = await grantCredits(pool, {
      billingAccountId: accountId,
      product: parseProduct(body.product),
      source: source as
        | "PLAN"
        | "TRIAL"
        | "PURCHASE"
        | "REFERRAL"
        | "MIGRATION"
        | "PROMOTION"
        | "ADJUSTMENT",
      amount: bigValue(body.amount, "Credit amount", 1n),
      startsAt: body.startsAt ? dateValue(body.startsAt, "Grant start") : new Date(),
      endsAt: body.endsAt ? dateValue(body.endsAt, "Grant end") : null,
      reference: optionalText(body.reference, 240),
      idempotencyKey: text(body.idempotencyKey, "Credit idempotency key", 240),
      metadata: jsonObject(body.metadata),
    });
    await audit(pool, actor.id, "account.credits.grant", "billing_account", accountId, body);
    return {
      grantId: result.grantId,
      balance: result.balance.toString(),
      replayed: result.replayed,
      currency: account.currency,
    };
  });

  app.post("/admin/accounts/:id/subscriptions/assign", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const accountId = text((request.params as { id: string }).id, "Account id", 120);
    const subscription = await assignPlan(pool, {
      accountId,
      planKey: text(body.planKey, "Plan key", 80),
      status: body.status === "trialing" ? "trialing" : "active",
      trialDays:
        body.status === "trialing"
          ? Number(bigValue(body.trialDays ?? 14, "Trial days", 1n, 365n))
          : undefined,
      reason: optionalText(body.reason, 500) ?? "Admin assignment",
    });
    await audit(pool, actor.id, "account.subscription.assign", "billing_account", accountId, body);
    return subscription;
  });

  app.post(
    "/admin/accounts/:id/subscriptions/:subscriptionId/trial/extend",
    async (request) => {
      const { actor, body } = await adminRequest(request as RawBodyRequest);
      const accountId = text((request.params as { id: string }).id, "Account id", 120);
      const subscriptionId = text(
        (request.params as { subscriptionId: string }).subscriptionId,
        "Subscription id",
        120,
      );
      const days = Number(bigValue(body.days ?? 7, "Trial days", 1n, 365n));
      const subscription = await extendTrialSubscription(
        pool,
        accountId,
        subscriptionId,
        days,
      );
      await audit(
        pool,
        actor.id,
        "account.subscription.trial.extend",
        "subscription",
        subscriptionId,
        body,
      );
      return subscription;
    },
  );

  app.post(
    "/admin/accounts/:id/subscriptions/:subscriptionId/trial/end",
    async (request) => {
      const { actor, body } = await adminRequest(request as RawBodyRequest);
      const accountId = text((request.params as { id: string }).id, "Account id", 120);
      const subscriptionId = text(
        (request.params as { subscriptionId: string }).subscriptionId,
        "Subscription id",
        120,
      );
      const result = await endTrialSubscription(
        pool,
        config,
        accountId,
        subscriptionId,
      );
      await audit(
        pool,
        actor.id,
        "account.subscription.trial.end",
        "subscription",
        subscriptionId,
        body,
      );
      return result;
    },
  );

  app.get("/admin/accounts", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const query = request.query as {
      q?: string;
      product?: string;
      tenantId?: string;
      limit?: string;
    };
    const limit = Math.min(500, Math.max(1, Number(query.limit ?? 50) || 50));
    const result = await pool.query(
      `SELECT a.id, a.name, a.status, a.currency, a.billing_email,
              a.entitlements_revision::text,
              COALESCE(c.balance,0)::text AS balance,
              COALESCE(c.reserved_balance,0)::text AS reserved_balance,
              COALESCE(json_agg(json_build_object(
                'product', l.product, 'tenantId', l.tenant_id, 'role', l.role, 'status', l.status
              ) ORDER BY l.product, l.tenant_id) FILTER (WHERE l.id IS NOT NULL), '[]'::json) AS links
         FROM billing.accounts a
         LEFT JOIN billing.credit_accounts c ON c.billing_account_id=a.id
         LEFT JOIN billing.account_links l ON l.billing_account_id=a.id
        WHERE ($1::text IS NULL OR a.name ILIKE '%' || $1 || '%' OR a.billing_email ILIKE '%' || $1 || '%'
               OR EXISTS (SELECT 1 FROM billing.account_links q
                           WHERE q.billing_account_id=a.id AND q.tenant_id ILIKE '%' || $1 || '%'))
          AND ($2::text IS NULL OR EXISTS (
                SELECT 1 FROM billing.account_links p
                 WHERE p.billing_account_id=a.id AND p.product=$2
                   AND ($3::text IS NULL OR p.tenant_id=$3)))
        GROUP BY a.id, c.balance, c.reserved_balance
        ORDER BY a.created_at DESC LIMIT $4`,
      [optionalText(query.q, 200), query.product ?? null, query.tenantId ?? null, limit],
    );
    return {
      organizations: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        currency: row.currency,
        billingEmail: row.billing_email,
        entitlementsRevision: row.entitlements_revision,
        balance: row.balance,
        reservedBalance: row.reserved_balance,
        links: row.links,
      })),
    };
  });

  app.get("/admin/tenants/:product/:tenantId", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const product = parseProduct((request.params as { product: string }).product);
    const tenantId = text((request.params as { tenantId: string }).tenantId, "Tenant id", 256);
    const { account } = await getAccountForTenant(pool, product, tenantId);
    return accountSummary(pool, account.id);
  });

  app.get("/admin/tenants/:product/:tenantId/credits", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const product = parseProduct((request.params as { product: string }).product);
    const tenantId = text((request.params as { tenantId: string }).tenantId, "Tenant id", 256);
    const { account } = await getAccountForTenant(pool, product, tenantId);
    const grants = await pool.query(
      `SELECT g.id, g.source, g.amount::text, g.remaining::text,
              g.starts_at, g.ends_at, g.reference, g.metadata
         FROM billing.credit_grants g
         JOIN billing.credit_accounts c ON c.id=g.account_id
        WHERE c.billing_account_id=$1
        ORDER BY g.created_at DESC LIMIT 100`,
      [account.id],
    );
    return {
      credits: await getCreditSummary(pool, account.id),
      grants: grants.rows.map((row) => ({
        id: row.id,
        source: row.source,
        amount: Number(row.amount),
        remainingAmount: Number(row.remaining),
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        reason: null,
        reference: row.reference,
      })),
      orgId: tenantId,
      balance: Number((await getCreditSummary(pool, account.id)).balance),
      reservedBalance: Number((await getCreditSummary(pool, account.id)).reserved),
      availableBalance: Number((await getCreditSummary(pool, account.id)).available),
      ledger: (await listCreditLedger(pool, account.id, 500)).map((entry) => ({
        ...entry,
        entryType: entry.type,
        sourceType: null,
      })),
    };
  });

  app.post("/admin/tenants/:product/:tenantId/credits/grant", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const product = parseProduct((request.params as { product: string }).product);
    const tenantId = text((request.params as { tenantId: string }).tenantId, "Tenant id", 256);
    const { account } = await getAccountForTenant(pool, product, tenantId);
    const source = String(body.source ?? "ADJUSTMENT").toUpperCase();
    if (
      !["PLAN", "TRIAL", "PURCHASE", "REFERRAL", "MIGRATION", "PROMOTION", "ADJUSTMENT"].includes(
        source,
      )
    )
      bad("Credit source is invalid");
    const result = await grantCredits(pool, {
      billingAccountId: account.id,
      product,
      source: source as
        | "PLAN"
        | "TRIAL"
        | "PURCHASE"
        | "REFERRAL"
        | "MIGRATION"
        | "PROMOTION"
        | "ADJUSTMENT",
      amount: bigValue(body.amount, "Credit amount", 1n),
      startsAt: body.startsAt ? dateValue(body.startsAt, "Grant start") : new Date(),
      endsAt: body.endsAt ? dateValue(body.endsAt, "Grant end") : null,
      reference: optionalText(body.reference, 240),
      idempotencyKey: text(body.idempotencyKey, "Credit idempotency key", 240),
      metadata: jsonObject(body.metadata),
    });
    await audit(pool, actor.id, "tenant.credits.grant", "billing_account", account.id, body);
    return {
      grantId: result.grantId,
      balance: result.balance.toString(),
      replayed: result.replayed,
      currency: account.currency,
    };
  });

  app.post("/admin/tenants/:product/:tenantId/credits/balance", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const product = parseProduct((request.params as { product: string }).product);
    const tenantId = text((request.params as { tenantId: string }).tenantId, "Tenant id", 256);
    const { account } = await getAccountForTenant(pool, product, tenantId);
    const result = await setCreditBalance(pool, {
      billingAccountId: account.id,
      product,
      targetBalance: bigValue(body.targetBalance, "Target balance", 0n),
      reason: text(body.reason, "Adjustment reason", 500),
      reference: optionalText(body.reference, 240),
      actorId: actor.id,
      idempotencyKey: text(body.idempotencyKey, "Adjustment idempotency key", 240),
    });
    await audit(pool, actor.id, "tenant.credits.balance", "billing_account", account.id, body);
    return {
      balance: result.balance.toString(),
      adjustment: result.adjustment.toString(),
      replayed: result.replayed,
      currency: account.currency,
    };
  });

  app.post("/admin/tenants/:product/:tenantId/grants", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const product = parseProduct((request.params as { product: string }).product);
    const tenantId = text((request.params as { tenantId: string }).tenantId, "Tenant id", 256);
    const { account } = await getAccountForTenant(pool, product, tenantId);
    const key = text(body.key, "Grant key", 120);
    const startsAt = body.startsAt ? dateValue(body.startsAt, "Grant start") : new Date();
    const endsAt = body.endsAt ? dateValue(body.endsAt, "Grant end") : null;
    if (endsAt && endsAt <= startsAt) bad("Grant expiry must be after its start");
    await pool.query(
      `INSERT INTO billing.account_grants(
         id, billing_account_id, key, value, source, starts_at, ends_at, reason, created_by
       ) VALUES('grt_' || gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        account.id,
        key,
        JSON.stringify(body.value),
        body.source === "TRIAL" || body.source === "MIGRATION" || body.source === "PROMOTION"
          ? body.source
          : "MANUAL",
        startsAt,
        endsAt,
        optionalText(body.reason, 500),
        actor.id,
      ],
    );
    await pool.query(
      `UPDATE billing.accounts SET entitlements_revision=entitlements_revision+1, updated_at=now() WHERE id=$1`,
      [account.id],
    );
    await audit(pool, actor.id, "tenant.grant.create", "billing_account", account.id, body);
    return { created: true };
  });

  app.post("/admin/tenants/:product/:tenantId/subscriptions/assign", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const product = parseProduct((request.params as { product: string }).product);
    const tenantId = text((request.params as { tenantId: string }).tenantId, "Tenant id", 256);
    const { account } = await getAccountForTenant(pool, product, tenantId);
    const planKey = text(body.planKey, "Plan key", 80);
    const plan = await getPlanDetails(pool, planKey);
    if (plan.product !== product) bad("That plan belongs to another product");
    const subscription = await assignPlan(pool, {
      accountId: account.id,
      planKey,
      status: body.status === "trialing" ? "trialing" : "active",
      trialDays:
        body.status === "trialing"
          ? Number(bigValue(body.trialDays ?? 14, "Trial days", 1n, 365n))
          : undefined,
      reason: optionalText(body.reason, 500) ?? "Admin assignment",
    });
    await audit(pool, actor.id, "tenant.subscription.assign", "billing_account", account.id, body);
    return subscription;
  });

  app.get("/admin/tenants/:product/:tenantId/invoices", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const product = parseProduct((request.params as { product: string }).product);
    const tenantId = text((request.params as { tenantId: string }).tenantId, "Tenant id", 256);
    const { account } = await getAccountForTenant(pool, product, tenantId);
    return { invoices: await listInvoices(pool, account.id, 500) };
  });

  app.get("/admin/accounts/:id", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    return accountSummary(
      pool,
      text((request.params as { id: string }).id, "Account id", 120),
    );
  });

  app.get("/admin/accounts/:id/invoices", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    return {
      invoices: await listInvoices(
        pool,
        text((request.params as { id: string }).id, "Account id", 120),
        500,
      ),
    };
  });

  app.get("/admin/accounts/:id/credits", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const accountId = text((request.params as { id: string }).id, "Account id", 120);
    const account = await getAccountById(pool, accountId);
    return {
      credits: await getCreditSummary(pool, accountId),
      ledger: await listCreditLedger(pool, accountId, 500),
    };
  });

  app.get("/admin/reconciliation-issues", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const query = request.query as { status?: string };
    const status = query.status === "resolved" ? "resolved" : query.status === "open" ? "open" : null;
    const result = await pool.query(
      `SELECT id, billing_account_id, provider, resource_type, resource_id,
              issue_type, status, details, detected_at, resolved_at
         FROM billing.reconciliation_issues
        WHERE ($1::text IS NULL OR status=$1)
        ORDER BY detected_at DESC LIMIT 500`,
      [status],
    );
    return {
      issues: result.rows.map((row) => ({
        id: row.id,
        billingAccountId: row.billing_account_id,
        provider: row.provider,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        issueType: row.issue_type,
        status: row.status,
        details: row.details,
        detectedAt: row.detected_at,
        resolvedAt: row.resolved_at,
      })),
    };
  });

  app.post("/admin/reconciliation-issues/:id/resolve", async (request) => {
    const { actor, body } = await adminRequest(request as RawBodyRequest);
    const id = text((request.params as { id: string }).id, "Issue id", 120);
    const reason = text(body.reason, "Resolution reason", 500);
    const result = await pool.query(
      `UPDATE billing.reconciliation_issues
          SET status='resolved', resolved_at=now(), updated_at=now(),
              details=details || jsonb_build_object('resolution', $2::text, 'resolvedBy', $3::text)
        WHERE id=$1 AND status='open'`,
      [id, reason, actor.id],
    );
    if (!result.rowCount) missing("Open reconciliation issue not found");
    await audit(pool, actor.id, "reconciliation.resolve", "reconciliation_issue", id, { reason });
    return { resolved: true };
  });

  app.get("/admin/audit", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const result = await pool.query(
      `SELECT id, actor_id, action, resource_type, resource_id, details, created_at
         FROM billing.audit ORDER BY created_at DESC LIMIT 500`,
    );
    return { audit: result.rows };
  });

  app.get("/admin/metrics", async (request) => {
    await adminRequest(request as RawBodyRequest, "admin:read");
    const [subscriptions, issues, credits] = await Promise.all([
      pool.query<{
        product_key: string;
        active: string;
        trialing: string;
        past_due: string;
        mrr_minor: string;
      }>(
        `SELECT s.product_key,
                COUNT(*) FILTER (WHERE s.status IN ('active','past_due','grace'))::text AS active,
                COUNT(*) FILTER (WHERE s.status='trialing')::text AS trialing,
                COUNT(*) FILTER (WHERE s.status='past_due')::text AS past_due,
                COALESCE(SUM(v.amount_minor) FILTER (WHERE s.status IN ('active','past_due','grace')),0)::text AS mrr_minor
           FROM billing.subscriptions s
           JOIN billing.plan_versions v ON v.id=s.plan_version_id
          GROUP BY s.product_key ORDER BY s.product_key`,
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM billing.reconciliation_issues WHERE status='open'`,
      ),
      pool.query<{ balance: string }>(
        `SELECT COALESCE(SUM(balance),0)::text AS balance FROM billing.credit_accounts`,
      ),
    ]);
    return {
      subscriptions: subscriptions.rows,
      openIssues: Number(issues.rows[0]?.count ?? "0"),
      creditBalance: credits.rows[0]?.balance ?? "0",
    };
  });

  // ─── Paystack webhook ───────────────────────────────────

  app.register(async (webhook) => {
    webhook.removeAllContentTypeParsers();
    webhook.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: 262_144 },
      (_request, body, done) => done(null, body),
    );
    webhook.post(
      "/webhooks/paystack",
      { bodyLimit: 262_144 },
      async (request, reply) => {
        if (!config.paystack)
          return reply.code(503).send({ error: "Paystack is not configured" });
        const provider = productProvider();
        const signature = request.headers["x-paystack-signature"];
        if (
          !Buffer.isBuffer(request.body) ||
          typeof signature !== "string" ||
          !provider.verifyWebhook(request.body, signature)
        )
          return reply.code(401).send({ error: "Unauthorized" });
        let payload: unknown;
        try {
          payload = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(request.body),
          );
        } catch {
          return reply.code(400).send({ error: "Invalid webhook payload" });
        }
        try {
          return await handleWebhook(pool, config, provider, payload);
        } catch (error) {
          request.log.error(
            { event: "webhook.failed", provider: provider.name },
            error instanceof Error ? error.message : "unknown",
          );
          return reply.code(500).send({ error: "Webhook processing failed" });
        }
      },
    );
  });

  return app;
}
