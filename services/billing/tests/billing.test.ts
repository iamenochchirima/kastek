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

test("invalid webhook signature is rejected", { skip }, async () => {
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/paystack",
    headers: { "content-type": "application/json", "x-paystack-signature": "0".repeat(128) },
    payload: JSON.stringify({ event: "charge.success", data: {} }),
  });
  assert.equal(response.statusCode, 401);
});
