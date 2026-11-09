import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import {
  BILLING_AUTHORITY_HEADER,
  createBillingAuthority,
} from "@kasitek-labs/server-support/billing-authority";
import { createAdminAuthority } from "@kasitek-labs/server-support/admin-authority";
import { loadConfig } from "../src/config.js";
import { buildApi } from "../src/api.js";
import { expireTrialsAndGrace } from "../src/subscriptions.js";
import { activateDueScheduledPlanVersions } from "../src/catalog.js";
import type { BillingConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate-main.js";
import { seed } from "../src/seed-main.js";

const databaseUrl = process.env.BILLING_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "Set BILLING_TEST_DATABASE_URL to a disposable PostgreSQL database";

const INTERNAL_SECRET = "billing-test-internal-secret-000000000000";
const SNAPSHOT_SECRET = "billing-test-snapshot-secret-000000000000";
const ADMIN_SECRET = "billing-test-admin-secret-0000000000000000";
const PAYSTACK_SECRET = "sk_test_billing_fixture";

interface FakeTransaction {
  amount: number;
  currency: string;
  email: string;
  customer: string;
  subscription: string;
  periodStart: string;
  periodEnd: string;
  status: string;
}

class FakePaystack {
  server!: Server;
  url!: string;
  transactions = new Map<string, FakeTransaction>();

  async start(): Promise<void> {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Fake Paystack failed");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  setTransaction(reference: string, value: FakeTransaction): void {
    this.transactions.set(reference, value);
  }

  private async body(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "POST" && url.pathname === "/transaction/initialize") {
      const body = JSON.parse(await this.body(request)) as {
        reference: string;
        amount: number;
        currency: string;
        email: string;
        plan: string;
        callback_url: string;
      };
      this.transactions.set(body.reference, {
        amount: body.amount,
        currency: body.currency,
        email: body.email,
        customer: "CUS_TEST",
        subscription: `SUB_${body.reference}`,
        periodStart: "2026-12-01T00:00:00.000Z",
        periodEnd: "2027-01-01T00:00:00.000Z",
        status: "success",
      });
      return send(200, {
        status: true,
        data: {
          authorization_url: `https://pay.example/${body.reference}`,
          reference: body.reference,
        },
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/transaction/verify/")) {
      const reference = decodeURIComponent(url.pathname.slice("/transaction/verify/".length));
      const value = this.transactions.get(reference);
      if (!value) return send(404, { status: false, message: "Transaction not found" });
      return send(200, {
        status: true,
        data: {
          id: 123456,
          status: value.status,
          reference,
          amount: value.amount,
          currency: value.currency,
          customer: { customer_code: value.customer },
          subscription: { subscription_code: value.subscription },
        },
      });
    }
    if (request.method === "GET" && url.pathname.startsWith("/subscription/")) {
      const id = decodeURIComponent(url.pathname.slice("/subscription/".length));
      return send(200, {
        status: true,
        data: {
          subscription_code: id,
          status: "active",
          email_token: "email-token",
          next_payment_date: "2027-01-01T00:00:00.000Z",
          most_recent_invoice: {
            invoice_code: "INV_TEST",
            period_start: "2026-12-01T00:00:00.000Z",
            period_end: "2027-01-01T00:00:00.000Z",
          },
        },
      });
    }
    if (
      request.method === "POST" &&
      ["/subscription/disable", "/subscription/enable"].includes(url.pathname)
    )
      return send(200, { status: true, data: {} });
    return send(404, { status: false, message: "Not found" });
  }
}

function productHeaders(
  method: string,
  path: string,
  body?: unknown,
  product: "growth" | "agents" | "agency" = "growth",
): Record<string, string> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  return {
    "content-type": "application/json",
    [BILLING_AUTHORITY_HEADER]: createBillingAuthority({
      secret: INTERNAL_SECRET,
      product,
      method,
      path,
      body: raw,
    }),
  };
}

function adminHeaders(
  method: string,
  path: string,
  body?: unknown,
  capability: "admin:read" | "admin:write" = "admin:write",
): Record<string, string> {
  const raw = body === undefined ? "" : JSON.stringify(body);
  return {
    "content-type": "application/json",
    "x-kasitek-admin-authority": createAdminAuthority({
      secret: ADMIN_SECRET,
      audience: "billing",
      actor: { id: "admin-test", role: "superadmin" },
      method,
      path,
      body: raw,
      capability,
    }),
  };
}

let app: FastifyInstance;
let pool: pg.Pool;
let fake: FakePaystack;
let config: BillingConfig;

before(async () => {
  if (skip) return;
  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query("DROP SCHEMA IF EXISTS billing CASCADE");
  await reset.end();
  await migrate(databaseUrl!);
  await seed(databaseUrl!);

  fake = new FakePaystack();
  await fake.start();
  config = loadConfig({
    ...process.env,
    BILLING_ENVIRONMENT: "test",
    BILLING_DATABASE_URL: databaseUrl,
    BILLING_PUBLIC_URL: "http://localhost:4500",
    BILLING_INTERNAL_SECRET: INTERNAL_SECRET,
    BILLING_SNAPSHOT_SECRET: SNAPSHOT_SECRET,
    KASITEK_ADMIN_SERVICE_SECRET: ADMIN_SECRET,
    BILLING_ADMIN_AUDIENCE: "billing",
    BILLING_RETURN_ORIGINS: "http://localhost:3000",
    BILLING_FREE_PLANS_JSON: '{"growth":"growth-free","agents":"agents-free","agency":"agency-free"}',
    BILLING_TRIAL_PLANS_JSON: '{"growth":"growth-mid"}',
    BILLING_TRIAL_DAYS: "14",
    PAYSTACK_MODE: "test",
    PAYSTACK_TEST_SECRET_KEY: PAYSTACK_SECRET,
    PAYSTACK_API_BASE_URL: fake.url,
  });
  pool = createPool(config.databaseUrl);
  app = await buildApi(pool, config);
});

after(async () => {
  if (skip) return;
  await app.close();
  await pool.end();
  await fake.stop();
});

test("billing service health and catalog", { skip }, async () => {
  const health = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(health.statusCode, 200);
  const catalog = await app.inject({
    method: "GET",
    url: "/admin/catalog",
    headers: adminHeaders("GET", "/admin/catalog", undefined, "admin:read"),
  });
  assert.equal(catalog.statusCode, 200);
  const body = catalog.json();
  assert.ok(body.products.some((product: { key: string }) => product.key === "growth"));
  assert.ok(body.plans.some((plan: { key: string }) => plan.key === "growth-free"));
});

test("account, free plan, checkout, tax invoice, usage, renewal and refund", { skip }, async () => {
  const planBody = {
    product: "growth",
    key: "growth-test",
    name: "Growth Test",
    amountMinor: "35000",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "1000",
    paystackPlanCode: "PLN_TEST",
    active: true,
    entitlements: [
      { key: "feature.inbox.access", value: true },
      { key: "limit.public_api_requests", value: 1000 },
    ],
  };
  const plan = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", planBody),
    payload: planBody,
  });
  assert.equal(plan.statusCode, 200, plan.body);
  const planVersionId = plan.json().versionId as string;
  const published = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${planVersionId}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${planVersionId}/publish`, {}),
    payload: {},
  });
  assert.equal(published.statusCode, 200, published.body);

  const accountBody = {
    product: "growth",
    tenantId: "org-test",
    name: "Test Org",
    billingEmail: "billing@example.test",
  };
  const account = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  assert.equal(account.statusCode, 200, account.body);
  const accountId = account.json().accountId as string;

  const entitlement = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-test",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(entitlement.statusCode, 200, entitlement.body);
  assert.equal(entitlement.json().snapshot.plan.key, "growth-free");
  assert.equal(entitlement.json().snapshot.features["feature.inbox.access"], true);

  const checkoutBody = {
    product: "growth",
    tenantId: "org-test",
    planKey: "growth-test",
    email: "billing@example.test",
    idempotencyKey: "checkout-one",
    returnUrl: "http://localhost:3000/billing?payment=complete",
  };
  const checkout = await app.inject({
    method: "POST",
    url: "/internal/checkout",
    headers: productHeaders("POST", "/internal/checkout", checkoutBody),
    payload: checkoutBody,
  });
  assert.equal(checkout.statusCode, 200, checkout.body);
  const reference = checkout.json().reference as string;
  assert.match(checkout.json().authorizationUrl, /pay\.example/);

  const verified = await app.inject({
    method: "POST",
    url: `/internal/checkout/${reference}/verify`,
    headers: productHeaders("POST", `/internal/checkout/${reference}/verify`, {
      tenantId: "org-test",
    }),
    payload: { tenantId: "org-test" },
  });
  assert.equal(verified.statusCode, 200, verified.body);
  assert.equal(verified.json().status, "completed");
  const subscriptionId = verified.json().subscriptionId as string;

  const invoices = await app.inject({
    method: "GET",
    url: "/internal/invoices?product=growth&tenantId=org-test",
    headers: productHeaders("GET", "/internal/invoices"),
  });
  assert.equal(invoices.statusCode, 200, invoices.body);
  const firstInvoice = invoices.json().invoices[0];
  assert.equal(firstInvoice.totalMinor, "35000");
  assert.equal(firstInvoice.taxMinor, "4565");
  assert.equal(firstInvoice.subtotalMinor, "30435");

  const credits = await app.inject({
    method: "GET",
    url: "/internal/credits?product=growth&tenantId=org-test",
    headers: productHeaders("GET", "/internal/credits"),
  });
  assert.equal(credits.statusCode, 200, credits.body);
  assert.equal(credits.json().credits.balance, "1000");

  const capabilityBody = {
    product: "growth",
    key: "growth_ai_tokens",
    name: "AI tokens",
    kind: "meter",
    unit: "token",
    creditCostPerUnit: "1",
    creditCostMinimum: "0",
    active: true,
  };
  const capability = await app.inject({
    method: "POST",
    url: "/admin/capabilities",
    headers: adminHeaders("POST", "/admin/capabilities", capabilityBody),
    payload: capabilityBody,
  });
  assert.equal(capability.statusCode, 200, capability.body);

  const usageBody = {
    product: "growth",
    tenantId: "org-test",
    meterKey: "growth_ai_tokens",
    quantity: "100",
    idempotencyKey: "usage-one",
  };
  const usage = await app.inject({
    method: "POST",
    url: "/internal/usage",
    headers: productHeaders("POST", "/internal/usage", usageBody),
    payload: usageBody,
  });
  assert.equal(usage.statusCode, 200, usage.body);
  assert.equal(usage.json().creditsCharged, "100");
  assert.equal(usage.json().balance, "900");

  const renewal = {
    event: "charge.success",
    data: {
      id: 777,
      status: "success",
      reference: "renewal-1",
      amount: 35000,
      currency: "ZAR",
      customer: { customer_code: "CUS_TEST" },
      subscription: { subscription_code: `SUB_${reference}` },
      invoice_code: "INV_RENEWAL",
    },
  };
  const raw = JSON.stringify(renewal);
  const signature = createHmac("sha512", PAYSTACK_SECRET).update(raw).digest("hex");
  const webhook = await app.inject({
    method: "POST",
    url: "/webhooks/paystack",
    headers: {
      "content-type": "application/json",
      "x-paystack-signature": signature,
    },
    payload: raw,
  });
  assert.equal(webhook.statusCode, 200, webhook.body);
  assert.equal(webhook.json().processed, true);

  const afterRenewal = await app.inject({
    method: "GET",
    url: "/internal/invoices?product=growth&tenantId=org-test",
    headers: productHeaders("GET", "/internal/invoices"),
  });
  assert.equal(afterRenewal.json().invoices.length, 2);
  const recurring = afterRenewal.json().invoices.find(
    (invoice: { invoiceNumber: string }) => invoice.invoiceNumber.startsWith("KS-"),
  );
  assert.ok(recurring);

  const refund = {
    event: "refund.processed",
    data: {
      transaction_reference: "renewal-1",
      amount: 35000,
    },
  };
  const refundRaw = JSON.stringify(refund);
  const refundSignature = createHmac("sha512", PAYSTACK_SECRET)
    .update(refundRaw)
    .digest("hex");
  const refundResponse = await app.inject({
    method: "POST",
    url: "/webhooks/paystack",
    headers: {
      "content-type": "application/json",
      "x-paystack-signature": refundSignature,
    },
    payload: refundRaw,
  });
  assert.equal(refundResponse.statusCode, 200, refundResponse.body);
  assert.equal(refundResponse.json().processed, true);

  const afterRefund = await app.inject({
    method: "GET",
    url: "/internal/credits?product=growth&tenantId=org-test",
    headers: productHeaders("GET", "/internal/credits"),
  });
  assert.equal(afterRefund.json().credits.balance, "0");

  const accountView = await app.inject({
    method: "GET",
    url: `/admin/accounts/${accountId}`,
    headers: adminHeaders("GET", `/admin/accounts/${accountId}`, undefined, "admin:read"),
  });
  assert.equal(accountView.statusCode, 200, accountView.body);
  assert.equal(accountView.json().account.id, accountId);
});

test("amount mismatch is rejected and recorded", { skip }, async () => {
  const accountBody = {
    product: "growth",
    tenantId: "org-mismatch",
    name: "Mismatch Org",
    billingEmail: "mismatch@example.test",
  };
  await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  const checkoutBody = {
    product: "growth",
    tenantId: "org-mismatch",
    planKey: "growth-test",
    email: "mismatch@example.test",
    idempotencyKey: "checkout-mismatch",
    returnUrl: "http://localhost:3000/billing?payment=complete",
  };
  const checkout = await app.inject({
    method: "POST",
    url: "/internal/checkout",
    headers: productHeaders("POST", "/internal/checkout", checkoutBody),
    payload: checkoutBody,
  });
  assert.equal(checkout.statusCode, 200, checkout.body);
  const reference = checkout.json().reference as string;
  fake.setTransaction(reference, {
    amount: 100,
    currency: "ZAR",
    customer: "CUS_TEST",
    subscription: "SUB_MISMATCH",
    periodStart: "2026-12-01T00:00:00.000Z",
    periodEnd: "2027-01-01T00:00:00.000Z",
    status: "success",
  });
  const verified = await app.inject({
    method: "POST",
    url: `/internal/checkout/${reference}/verify`,
    headers: productHeaders("POST", `/internal/checkout/${reference}/verify`, {
      tenantId: "org-mismatch",
    }),
    payload: { tenantId: "org-mismatch" },
  });
  assert.equal(verified.statusCode, 409, verified.body);
  const issues = await app.inject({
    method: "GET",
    url: "/admin/reconciliation-issues?status=open",
    headers: adminHeaders("GET", "/admin/reconciliation-issues", undefined, "admin:read"),
  });
  assert.equal(issues.statusCode, 200, issues.body);
  assert.ok(
    issues
      .json()
      .issues.some(
        (issue: { issueType: string; resourceId: string }) =>
          issue.issueType === "amount_mismatch" && issue.resourceId === reference,
      ),
  );
});

test("VAT-exclusive plan charges gross and splits the invoice", { skip }, async () => {
  const planBody = {
    product: "growth",
    key: "growth-exclusive",
    name: "Growth Exclusive",
    amountMinor: "35000",
    currency: "ZAR",
    taxInclusive: false,
    taxRateBps: 1500,
    creditsPerPeriod: "500",
    paystackPlanCode: "PLN_EXCLUSIVE",
    active: true,
    entitlements: [{ key: "feature.inbox.access", value: true }],
  };
  const plan = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", planBody),
    payload: planBody,
  });
  assert.equal(plan.statusCode, 200, plan.body);
  const planVersionId = plan.json().versionId as string;
  const published = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${planVersionId}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${planVersionId}/publish`, {}),
    payload: {},
  });
  assert.equal(published.statusCode, 200, published.body);
  const accountBody = {
    product: "growth",
    tenantId: "org-exclusive",
    name: "Exclusive Org",
    billingEmail: "exclusive@example.test",
  };
  await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  const checkoutBody = {
    product: "growth",
    tenantId: "org-exclusive",
    planKey: "growth-exclusive",
    email: "exclusive@example.test",
    idempotencyKey: "checkout-exclusive",
    returnUrl: "http://localhost:3000/billing?payment=complete",
  };
  const checkout = await app.inject({
    method: "POST",
    url: "/internal/checkout",
    headers: productHeaders("POST", "/internal/checkout", checkoutBody),
    payload: checkoutBody,
  });
  assert.equal(checkout.statusCode, 200, checkout.body);
  const reference = checkout.json().reference as string;
  const verified = await app.inject({
    method: "POST",
    url: `/internal/checkout/${reference}/verify`,
    headers: productHeaders("POST", `/internal/checkout/${reference}/verify`, {
      tenantId: "org-exclusive",
    }),
    payload: { tenantId: "org-exclusive" },
  });
  assert.equal(verified.statusCode, 200, verified.body);
  const invoices = await app.inject({
    method: "GET",
    url: "/internal/invoices?product=growth&tenantId=org-exclusive",
    headers: productHeaders("GET", "/internal/invoices"),
  });
  const invoice = invoices.json().invoices[0];
  assert.equal(invoice.subtotalMinor, "35000");
  assert.equal(invoice.taxMinor, "5250");
  assert.equal(invoice.totalMinor, "40250");
});

test("Agents and Agency free plans are assigned and entitled", { skip }, async () => {
  for (const [product, tenantId, feature] of [
    ["agents", "agents-org", "agents.feature.manage"],
    ["agency", "agency-workspace", "agency.feature.agents"],
  ] as const) {
    const body = {
      product,
      tenantId,
      name: `${product} org`,
      billingEmail: `${product}@example.test`,
    };
    const account = await app.inject({
      method: "POST",
      url: "/internal/accounts/ensure",
      headers: productHeaders("POST", "/internal/accounts/ensure", body, product),
      payload: body,
    });
    assert.equal(account.statusCode, 200, account.body);
    const snapshot = await app.inject({
      method: "GET",
      url: `/internal/entitlements?product=${product}&tenantId=${tenantId}`,
      headers: productHeaders("GET", "/internal/entitlements", undefined, product),
    });
    assert.equal(snapshot.statusCode, 200, snapshot.body);
    assert.notEqual(snapshot.json().snapshot.access, "none");
    assert.equal(snapshot.json().snapshot.features[feature], true);
  }
});

test("trial downgrade and grace expiry change access", { skip }, async () => {
  const accountBody = {
    product: "growth",
    tenantId: "org-lifecycle",
    name: "Lifecycle Org",
    billingEmail: "lifecycle@example.test",
  };
  await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  const assigned = await app.inject({
    method: "POST",
    url: "/admin/tenants/growth/org-lifecycle/subscriptions/assign",
    headers: adminHeaders("POST", "/admin/tenants/growth/org-lifecycle/subscriptions/assign", {
      planKey: "growth-test",
      status: "trialing",
      trialDays: 14,
    }),
    payload: { planKey: "growth-test", status: "trialing", trialDays: 14 },
  });
  assert.equal(assigned.statusCode, 200, assigned.body);
  let snapshot = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-lifecycle",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(snapshot.json().snapshot.access, "trialing");
  await pool.query(
    `UPDATE billing.subscriptions SET trial_ends_at=now()-interval '1 minute'
      WHERE billing_account_id=(SELECT id FROM billing.accounts WHERE billing_email='lifecycle@example.test')
        AND status='trialing'`,
  );
  await expireTrialsAndGrace(pool, config);
  snapshot = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-lifecycle",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(snapshot.json().snapshot.plan.key, "growth-free");
  await pool.query(
    `UPDATE billing.subscriptions SET status='past_due', grace_ends_at=now()+interval '1 day'
      WHERE billing_account_id=(SELECT id FROM billing.accounts WHERE billing_email='lifecycle@example.test')
        AND status='active'`,
  );
  snapshot = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-lifecycle",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(snapshot.json().snapshot.access, "grace");
  await pool.query(
    `UPDATE billing.subscriptions SET grace_ends_at=now()-interval '1 minute'
      WHERE billing_account_id=(SELECT id FROM billing.accounts WHERE billing_email='lifecycle@example.test')
        AND status='past_due'`,
  );
  await expireTrialsAndGrace(pool, config);
  snapshot = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-lifecycle",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(snapshot.json().snapshot.access, "none");
});

test("admin can start, extend and end a trial", { skip }, async () => {
  const planBody = {
    product: "growth",
    key: "growth-trial-manage",
    name: "Trial management",
    amountMinor: "0",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "2500000",
    paystackPlanCode: null,
    entitlements: [{ key: "feature.inbox.access", value: true }],
  };
  const created = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", planBody),
    payload: planBody,
  });
  assert.equal(created.statusCode, 200, created.body);
  const published = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${created.json().versionId}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${created.json().versionId}/publish`, {}),
    payload: {},
  });
  assert.equal(published.statusCode, 200, published.body);

  const accountBody = {
    product: "growth",
    tenantId: "org-trial-manage",
    name: "Trial Manage",
    billingEmail: "trial-manage@example.test",
  };
  const ensured = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  assert.equal(ensured.statusCode, 200, ensured.body);
  const accountId = ensured.json().accountId as string;

  const assigned = await app.inject({
    method: "POST",
    url: "/admin/tenants/growth/org-trial-manage/subscriptions/assign",
    headers: adminHeaders("POST", "/admin/tenants/growth/org-trial-manage/subscriptions/assign", {
      planKey: "growth-trial-manage",
      status: "trialing",
      trialDays: 14,
    }),
    payload: {
      planKey: "growth-trial-manage",
      status: "trialing",
      trialDays: 14,
    },
  });
  assert.equal(assigned.statusCode, 200, assigned.body);
  const subscriptionId = assigned.json().id as string;

  let snapshot = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-trial-manage",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(snapshot.json().snapshot.access, "trialing");
  assert.equal(snapshot.json().snapshot.credits.balance, "2500000");
  const originalTrialEnd = new Date(
    snapshot.json().snapshot.subscription.trialEndsAt as string,
  ).getTime();

  const extended = await app.inject({
    method: "POST",
    url: `/admin/accounts/${accountId}/subscriptions/${subscriptionId}/trial/extend`,
    headers: adminHeaders(
      "POST",
      `/admin/accounts/${accountId}/subscriptions/${subscriptionId}/trial/extend`,
      { days: 30 },
    ),
    payload: { days: 30 },
  });
  assert.equal(extended.statusCode, 200, extended.body);
  const extendedEnd = new Date(extended.json().trial_ends_at as string).getTime();
  assert.ok(extendedEnd > originalTrialEnd + 29 * 86_400_000);

  const ended = await app.inject({
    method: "POST",
    url: `/admin/accounts/${accountId}/subscriptions/${subscriptionId}/trial/end`,
    headers: adminHeaders(
      "POST",
      `/admin/accounts/${accountId}/subscriptions/${subscriptionId}/trial/end`,
      {},
    ),
    payload: {},
  });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(ended.json().planKey, "growth-free");

  snapshot = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-trial-manage",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(snapshot.json().snapshot.access, "active");
  assert.equal(snapshot.json().snapshot.plan.key, "growth-free");
  assert.equal(snapshot.json().snapshot.credits.balance, "0");
});

test("product authority replay is rejected", { skip }, async () => {
  const body = {
    product: "growth",
    tenantId: "org-replay",
    name: "Replay Org",
    billingEmail: "replay@example.test",
  };
  const headers = productHeaders("POST", "/internal/accounts/ensure", body);
  const first = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers,
    payload: body,
  });
  assert.equal(first.statusCode, 200, first.body);
  const second = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers,
    payload: body,
  });
  assert.equal(second.statusCode, 401, second.body);
});

test("dynamic plan versions are published and existing subscriptions stay pinned", { skip }, async () => {
  const planBody = {
    product: "growth",
    key: "growth-dynamic",
    name: "Dynamic Growth",
    description: "Dynamic plan fixture",
    amountMinor: "45000",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "1000000",
    paystackPlanCode: "PLN_DYNAMIC",
    active: true,
    entitlements: [
      { key: "feature.inbox.access", value: true },
      { key: "limit.team_seats", value: 2 },
    ],
  };
  const created = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", planBody),
    payload: planBody,
  });
  assert.equal(created.statusCode, 200, created.body);
  const v1 = created.json().versionId as string;
  const publishedV1 = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${v1}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${v1}/publish`, {}),
    payload: {},
  });
  assert.equal(publishedV1.statusCode, 200, publishedV1.body);

  const activate = async (tenantId: string) => {
    const accountBody = {
      product: "growth",
      tenantId,
      name: `Dynamic ${tenantId}`,
      billingEmail: `${tenantId}@example.test`,
    };
    await app.inject({
      method: "POST",
      url: "/internal/accounts/ensure",
      headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
      payload: accountBody,
    });
    const checkoutBody = {
      product: "growth",
      tenantId,
      planKey: "growth-dynamic",
      email: `${tenantId}@example.test`,
      idempotencyKey: `checkout-${tenantId}`,
      returnUrl: "http://localhost:3000/billing?payment=complete",
    };
    const checkout = await app.inject({
      method: "POST",
      url: "/internal/checkout",
      headers: productHeaders("POST", "/internal/checkout", checkoutBody),
      payload: checkoutBody,
    });
    assert.equal(checkout.statusCode, 200, checkout.body);
    const reference = checkout.json().reference as string;
    const verified = await app.inject({
      method: "POST",
      url: `/internal/checkout/${reference}/verify`,
      headers: productHeaders("POST", `/internal/checkout/${reference}/verify`, { tenantId }),
      payload: { tenantId },
    });
    assert.equal(verified.statusCode, 200, verified.body);
    return reference;
  };
  await activate("org-dynamic-v1");
  const pinned = await pool.query<{ plan_version_id: string }>(
    `SELECT s.plan_version_id FROM billing.subscriptions s
      JOIN billing.accounts a ON a.id=s.billing_account_id
     WHERE a.billing_email='org-dynamic-v1@example.test' AND s.status='active'`,
  );
  assert.equal(pinned.rows[0]?.plan_version_id, v1);

  const version = await app.inject({
    method: "POST",
    url: "/admin/plans/growth-dynamic/versions",
    headers: adminHeaders("POST", "/admin/plans/growth-dynamic/versions", {}),
    payload: {},
  });
  assert.equal(version.statusCode, 200, version.body);
  const v2 = version.json().versionId as string;
  const entitlements = await app.inject({
    method: "PUT",
    url: `/admin/plan-versions/${v2}/entitlements`,
    headers: adminHeaders("PUT", `/admin/plan-versions/${v2}/entitlements`, {
      entitlements: [{ key: "limit.team_seats", value: 4 }],
    }),
    payload: { entitlements: [{ key: "limit.team_seats", value: 4 }] },
  });
  assert.equal(entitlements.statusCode, 200, entitlements.body);
  const publishedV2 = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${v2}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${v2}/publish`, {}),
    payload: {},
  });
  assert.equal(publishedV2.statusCode, 200, publishedV2.body);

  await activate("org-dynamic-v2");
  const subscriptions = await pool.query<{ email: string; plan_version_id: string }>(
    `SELECT a.billing_email AS email, s.plan_version_id FROM billing.subscriptions s
      JOIN billing.accounts a ON a.id=s.billing_account_id
     WHERE a.billing_email IN ('org-dynamic-v1@example.test','org-dynamic-v2@example.test')
       AND s.status='active' ORDER BY a.billing_email`,
  );
  assert.deepEqual(
    Object.fromEntries(subscriptions.rows.map((row) => [row.email, row.plan_version_id])),
    {
      "org-dynamic-v1@example.test": v1,
      "org-dynamic-v2@example.test": v2,
    },
  );
  const snapshots = await Promise.all(
    ["org-dynamic-v1", "org-dynamic-v2"].map((tenantId) =>
      app.inject({
        method: "GET",
        url: `/internal/entitlements?product=growth&tenantId=${tenantId}`,
        headers: productHeaders("GET", "/internal/entitlements"),
      }),
    ),
  );
  assert.equal(snapshots[0]!.json().snapshot.features["feature.inbox.access"], true);
  assert.equal(snapshots[1]!.json().snapshot.features["feature.inbox.access"], undefined);
  assert.equal(snapshots[1]!.json().snapshot.limits["limit.team_seats"], 4);

  const noCode = {
    product: "growth",
    key: "growth-no-code",
    name: "No Code",
    amountMinor: "1000",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "0",
    paystackPlanCode: null,
    active: true,
    entitlements: [{ key: "feature.inbox.access", value: true }],
  };
  const draft = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", noCode),
    payload: noCode,
  });
  assert.equal(draft.statusCode, 200, draft.body);
  const publishNoCode = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${draft.json().versionId}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${draft.json().versionId}/publish`, {}),
    payload: {},
  });
  assert.equal(publishNoCode.statusCode, 400, publishNoCode.body);
});

test("publish rejects unimplemented hard limits and accepts display-only limits", { skip }, async () => {
  const planBody = {
    product: "agency",
    key: "agency-display-limit",
    name: "Agency display limit",
    amountMinor: "0",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "0",
    paystackPlanCode: null,
    entitlements: [
      {
        key: "limit.agency_workspaces",
        value: 1,
        metadata: { enforcement: "hard" },
      },
    ],
  };
  const created = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", planBody),
    payload: planBody,
  });
  assert.equal(created.statusCode, 200, created.body);
  const v1 = created.json().versionId as string;
  const failed = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${v1}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${v1}/publish`, {}),
    payload: {},
  });
  assert.equal(failed.statusCode, 409, failed.body);

  const versionBody = {
    entitlements: [
      {
        key: "limit.agency_workspaces",
        value: 1,
        metadata: { enforcement: "display_only" },
      },
    ],
  };
  const version = await app.inject({
    method: "POST",
    url: "/admin/plans/agency-display-limit/versions",
    headers: adminHeaders("POST", "/admin/plans/agency-display-limit/versions", versionBody),
    payload: versionBody,
  });
  assert.equal(version.statusCode, 200, version.body);
  const v2 = version.json().versionId as string;
  const published = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${v2}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${v2}/publish`, {}),
    payload: {},
  });
  assert.equal(published.statusCode, 200, published.body);
});

test("checkout uses the account billing email and one provider customer", { skip }, async () => {
  const planBody = {
    product: "growth",
    key: "growth-payer",
    name: "Growth payer",
    amountMinor: "1000",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "0",
    paystackPlanCode: "PLN_PAYER_GROWTH",
    entitlements: [],
  };
  const created = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", planBody),
    payload: planBody,
  });
  assert.equal(created.statusCode, 200, created.body);
  const publish = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${created.json().versionId}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${created.json().versionId}/publish`, {}),
    payload: {},
  });
  assert.equal(publish.statusCode, 200, publish.body);

  const accountBody = {
    product: "growth",
    tenantId: "org-payer",
    name: "Payer Workspace",
    billingEmail: "payer@example.test",
  };
  const ensured = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  assert.equal(ensured.statusCode, 200, ensured.body);
  const accountId = ensured.json().accountId as string;
  const linkBody = { product: "agents", tenantId: "agents-payer", role: "payer" };
  const linked = await app.inject({
    method: "POST",
    url: `/admin/accounts/${accountId}/links`,
    headers: adminHeaders("POST", `/admin/accounts/${accountId}/links`, linkBody),
    payload: linkBody,
  });
  assert.equal(linked.statusCode, 200, linked.body);

  const agentsPlanBody = {
    product: "agents",
    key: "agents-payer",
    name: "Agents payer",
    amountMinor: "2000",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "0",
    paystackPlanCode: "PLN_PAYER_AGENTS",
    entitlements: [],
  };
  const agentsPlan = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", agentsPlanBody),
    payload: agentsPlanBody,
  });
  assert.equal(agentsPlan.statusCode, 200, agentsPlan.body);
  const agentsPublish = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${agentsPlan.json().versionId}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${agentsPlan.json().versionId}/publish`, {}),
    payload: {},
  });
  assert.equal(agentsPublish.statusCode, 200, agentsPublish.body);

  const checkout = async (
    product: "growth" | "agents",
    tenantId: string,
    planKey: string,
    email: string,
  ) => {
    const body = {
      product,
      tenantId,
      planKey,
      email,
      idempotencyKey: `payer-${product}`,
      returnUrl: "http://localhost:3000/billing?payment=complete",
    };
    const response = await app.inject({
      method: "POST",
      url: "/internal/checkout",
      headers: productHeaders("POST", "/internal/checkout", body, product),
      payload: body,
    });
    assert.equal(response.statusCode, 200, response.body);
    const reference = response.json().reference as string;
    const verified = await app.inject({
      method: "POST",
      url: `/internal/checkout/${reference}/verify`,
      headers: productHeaders(
        "POST",
        `/internal/checkout/${reference}/verify`,
        { tenantId },
        product,
      ),
      payload: { tenantId },
    });
    assert.equal(verified.statusCode, 200, verified.body);
    return reference;
  };
  const growthReference = await checkout(
    "growth",
    "org-payer",
    "growth-payer",
    "individual@example.test",
  );
  const agentsReference = await checkout(
    "agents",
    "agents-payer",
    "agents-payer",
    "another-individual@example.test",
  );
  assert.equal(fake.transactions.get(growthReference)?.email, "payer@example.test");
  assert.equal(fake.transactions.get(agentsReference)?.email, "payer@example.test");

  const account = await pool.query<{
    provider_customer_id: string | null;
    billing_email: string;
  }>(
    `SELECT provider_customer_id, billing_email FROM billing.accounts WHERE id=$1`,
    [accountId],
  );
  assert.equal(account.rows[0]?.billing_email, "payer@example.test");
  assert.equal(account.rows[0]?.provider_customer_id, "CUS_TEST");
  const subscriptions = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM billing.subscriptions
      WHERE billing_account_id=$1 AND status='active'`,
    [accountId],
  );
  assert.equal(subscriptions.rows[0]?.count, "2");
});

test("scheduled plan versions activate when their effective date passes", { skip }, async () => {
  const planBody = {
    product: "growth",
    key: "growth-scheduled",
    name: "Growth scheduled",
    amountMinor: "0",
    currency: "ZAR",
    taxInclusive: true,
    taxRateBps: 1500,
    creditsPerPeriod: "0",
    paystackPlanCode: null,
    entitlements: [],
  };
  const created = await app.inject({
    method: "POST",
    url: "/admin/plans",
    headers: adminHeaders("POST", "/admin/plans", planBody),
    payload: planBody,
  });
  assert.equal(created.statusCode, 200, created.body);
  const versionId = created.json().versionId as string;
  const effectiveFrom = new Date(Date.now() + 86_400_000).toISOString();
  const scheduled = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${versionId}/schedule`,
    headers: adminHeaders("POST", `/admin/plan-versions/${versionId}/schedule`, { effectiveFrom }),
    payload: { effectiveFrom },
  });
  assert.equal(scheduled.statusCode, 200, scheduled.body);
  assert.equal(scheduled.json().status, "scheduled");

  await pool.query(
    `UPDATE billing.plan_versions
        SET effective_from=now()-interval '1 second' WHERE id=$1`,
    [versionId],
  );
  assert.ok((await activateDueScheduledPlanVersions(pool)) >= 1);
  const row = await pool.query<{ status: string; active: boolean }>(
    `SELECT status, active FROM billing.plan_versions WHERE id=$1`,
    [versionId],
  );
  assert.deepEqual(row.rows[0], { status: "active", active: true });
});

test("accounts auto-link by shared owner identity and email", { skip }, async () => {
  const owner = {
    ownerIssuer: "https://identity.example.test/realms/kasitek",
    ownerSubject: "owner-link-1",
  };
  const growthBody = {
    product: "growth",
    tenantId: "org-link-growth",
    name: "Linked Growth",
    billingEmail: "linked@example.test",
    ...owner,
  };
  const growth = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", growthBody),
    payload: growthBody,
  });
  assert.equal(growth.statusCode, 200, growth.body);
  const accountId = growth.json().accountId as string;

  const agentsBody = {
    product: "agents",
    tenantId: "agents-link",
    name: "Linked Agents",
    billingEmail: "linked@example.test",
    ...owner,
  };
  const agents = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", agentsBody, "agents"),
    payload: agentsBody,
  });
  assert.equal(agents.statusCode, 200, agents.body);
  assert.equal(agents.json().accountId, accountId);

  const links = await pool.query<{ product: string }>(
    `SELECT product FROM billing.account_links
      WHERE billing_account_id=$1 AND status='active' ORDER BY product`,
    [accountId],
  );
  assert.deepEqual(links.rows.map((row) => row.product), ["agents", "growth"]);
  const subscriptions = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM billing.subscriptions
      WHERE billing_account_id=$1 AND status='active'`,
    [accountId],
  );
  assert.equal(subscriptions.rows[0]?.count, "2");

  const secondGrowthBody = {
    product: "growth",
    tenantId: "org-link-growth-2",
    name: "Second Linked Growth",
    billingEmail: "linked@example.test",
    ...owner,
  };
  const secondGrowth = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", secondGrowthBody),
    payload: secondGrowthBody,
  });
  assert.equal(secondGrowth.statusCode, 409, secondGrowth.body);

  const differentEmailBody = {
    product: "growth",
    tenantId: "org-link-growth-3",
    name: "Different Email Growth",
    billingEmail: "other-linked@example.test",
    ...owner,
  };
  const differentEmail = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", differentEmailBody),
    payload: differentEmailBody,
  });
  assert.equal(differentEmail.statusCode, 200, differentEmail.body);
  assert.notEqual(differentEmail.json().accountId, accountId);

  const differentIdentityBody = {
    product: "agents",
    tenantId: "agents-link-other-owner",
    name: "Other Owner Agents",
    billingEmail: "linked@example.test",
    ownerIssuer: owner.ownerIssuer,
    ownerSubject: "owner-link-2",
  };
  const differentIdentity = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", differentIdentityBody, "agents"),
    payload: differentIdentityBody,
  });
  assert.equal(differentIdentity.statusCode, 200, differentIdentity.body);
  assert.notEqual(differentIdentity.json().accountId, accountId);
});

test("usage summary aggregates daily debits and grants for the product", { skip }, async () => {
  const accountBody = {
    product: "growth",
    tenantId: "org-usage-report",
    name: "Usage Report",
    billingEmail: "usage-report@example.test",
  };
  const ensured = await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  assert.equal(ensured.statusCode, 200, ensured.body);
  const accountId = ensured.json().accountId as string;
  await pool.query(
    `INSERT INTO billing.usage_events(
       id, billing_account_id, product, tenant_id, meter_key, quantity,
       occurred_at, source_type, source_id, idempotency_key, credits_charged
     ) VALUES
       ('use_report_1',$1,'growth','org-usage-report','campaign_recipients',10,
        '2026-11-01T10:00:00Z','campaign','one','usage-report-1',100),
       ('use_report_2',$1,'growth','org-usage-report','campaign_recipients',20,
        '2026-11-02T10:00:00Z','campaign','two','usage-report-2',200)`,
    [accountId],
  );
  const response = await app.inject({
    method: "GET",
    url: "/internal/usage?product=growth&tenantId=org-usage-report&from=2026-11-01T00:00:00.000Z&to=2026-11-03T00:00:00.000Z",
    headers: productHeaders("GET", "/internal/usage"),
  });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.creditsUsed, "300");
  assert.equal(body.operations, "2");
  assert.deepEqual(body.daily, [
    { date: "2026-11-01", creditsUsed: "100", operations: "1" },
    { date: "2026-11-02", creditsUsed: "200", operations: "1" },
  ]);
  assert.deepEqual(body.breakdown, [
    { meterKey: "campaign_recipients", creditsUsed: "300", operations: "2" },
  ]);
  assert.equal(body.credits.currency, "USD");
});

test("self-serve trial is one per product and grants plan usage", { skip }, async () => {
  const detail = await app.inject({
    method: "GET",
    url: "/admin/plans/growth-mid",
    headers: adminHeaders("GET", "/admin/plans/growth-mid", undefined, "admin:read"),
  });
  assert.equal(detail.statusCode, 200, detail.body);
  const versionId = detail.json().versions[0].versionId as string;
  const updated = await app.inject({
    method: "PUT",
    url: `/admin/plan-versions/${versionId}`,
    headers: adminHeaders("PUT", `/admin/plan-versions/${versionId}`, {
      paystackPlanCode: "PLN_TRIAL_MID",
    }),
    payload: { paystackPlanCode: "PLN_TRIAL_MID" },
  });
  assert.equal(updated.statusCode, 200, updated.body);
  const published = await app.inject({
    method: "POST",
    url: `/admin/plan-versions/${versionId}/publish`,
    headers: adminHeaders("POST", `/admin/plan-versions/${versionId}/publish`, {}),
    payload: {},
  });
  assert.equal(published.statusCode, 200, published.body);

  const accountBody = {
    product: "growth",
    tenantId: "org-self-trial",
    name: "Self Trial",
    billingEmail: "self-trial@example.test",
  };
  await app.inject({
    method: "POST",
    url: "/internal/accounts/ensure",
    headers: productHeaders("POST", "/internal/accounts/ensure", accountBody),
    payload: accountBody,
  });
  const eligibility = await app.inject({
    method: "GET",
    url: "/internal/trials/eligibility?product=growth&tenantId=org-self-trial",
    headers: productHeaders("GET", "/internal/trials/eligibility"),
  });
  assert.equal(eligibility.statusCode, 200, eligibility.body);
  assert.deepEqual(eligibility.json(), {
    eligible: true,
    planKey: "growth-mid",
    days: 14,
    reason: "available",
  });

  const started = await app.inject({
    method: "POST",
    url: "/internal/trials",
    headers: productHeaders("POST", "/internal/trials", { tenantId: "org-self-trial" }),
    payload: { tenantId: "org-self-trial" },
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().started, true);
  const snapshot = await app.inject({
    method: "GET",
    url: "/internal/entitlements?product=growth&tenantId=org-self-trial",
    headers: productHeaders("GET", "/internal/entitlements"),
  });
  assert.equal(snapshot.json().snapshot.access, "trialing");
  assert.equal(snapshot.json().snapshot.plan.key, "growth-mid");
  assert.equal(snapshot.json().snapshot.credits.balance, "25000000");

  const repeated = await app.inject({
    method: "POST",
    url: "/internal/trials",
    headers: productHeaders("POST", "/internal/trials", { tenantId: "org-self-trial" }),
    payload: { tenantId: "org-self-trial" },
  });
  assert.equal(repeated.statusCode, 409, repeated.body);

  const account = await pool.query<{ id: string }>(
    `SELECT id FROM billing.accounts WHERE billing_email='self-trial@example.test'`,
  );
  const trial = await pool.query<{ id: string }>(
    `SELECT id FROM billing.subscriptions
      WHERE billing_account_id=$1 AND product_key='growth' AND status='trialing'`,
    [account.rows[0]!.id],
  );
  const ended = await app.inject({
    method: "POST",
    url: `/admin/accounts/${account.rows[0]!.id}/subscriptions/${trial.rows[0]!.id}/trial/end`,
    headers: adminHeaders(
      "POST",
      `/admin/accounts/${account.rows[0]!.id}/subscriptions/${trial.rows[0]!.id}/trial/end`,
      {},
    ),
    payload: {},
  });
  assert.equal(ended.statusCode, 200, ended.body);
  const afterEnd = await app.inject({
    method: "GET",
    url: "/internal/trials/eligibility?product=growth&tenantId=org-self-trial",
    headers: productHeaders("GET", "/internal/trials/eligibility"),
  });
  assert.equal(afterEnd.json().eligible, false);
  assert.equal(afterEnd.json().reason, "trial_used");
});

test("invalid webhook signature is rejected", { skip }, async () => {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/paystack",
    headers: { "content-type": "application/json", "x-paystack-signature": "0".repeat(128) },
    payload: JSON.stringify({ event: "charge.success", data: {} }),
  });
  assert.equal(response.statusCode, 401);
});
