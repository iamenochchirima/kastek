import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { parseCanonicalJson } from "@kasitek-labs/server-support/json";
import { installPgTimestampParsers } from "../src-ts/db.js";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { registerBillingRoutes } from "../src-ts/routes/billing.js";
import { registerReferralRoutes } from "../src-ts/routes/referrals.js";
import { installErrorHandler } from "../src-ts/error.js";
import { readConfig } from "../src-ts/config.js";
import type { CoreContext } from "../src-ts/context.js";
import {
  PaystackProvider,
  paystackEventKey,
  parseVerifiedTransaction,
  parseVerifiedSubscription,
  mergeEntitlementValue,
  internalSubscriptionState,
  createCheckout,
  verifyCheckout,
  getBillingSummary,
  getBillingUsage,
  processRecurringCharge,
  processProviderEvent,
  reconcileBilling,
} from "../src-ts/services/billing.js";
import type { BillingProvider } from "../src-ts/services/billing.js";
import {
  grantSystemCredits,
  reserveCredits,
  captureCredits,
  releaseCredits,
  getCreditAccount,
  expireCreditGrants,
} from "../src-ts/services/credits.js";
import {
  ensureReferralCode,
  attributeReferral,
  qualifyReferral,
  reverseReferral,
} from "../src-ts/services/referrals.js";
const rewards = {
  referrer_credits: 1000n,
  referee_credits: 500n,
  reward_expiry_days: 365,
  attribution_window_days: 90,
};
test("Paystack exact raw signatures, lossless IDs and persisted event identities", () => {
  const provider = new PaystackProvider("test-secret"),
    raw = Buffer.from(
      '{ "event": "charge.success", "data": { "id": 9007199254740993, "reference":"r", "status":"success" } }',
    ),
    signature = createHmac("sha512", "test-secret").update(raw).digest("hex");
  assert.equal(provider.verifyWebhook(raw, signature), true);
  assert.equal(
    provider.verifyWebhook(
      Buffer.from(raw.toString().replace("{ ", "{")),
      signature,
    ),
    false,
  );
  assert.equal(provider.verifyWebhook(raw, "f".repeat(128)), false);
  assert.equal(
    paystackEventKey({
      event: "charge.success",
      data: { id: 9007199254740993n },
    }),
    "charge.success:9007199254740993",
  );
  const verified = parseVerifiedTransaction({
    status: "success",
    reference: "r",
    id: 9007199254740993n,
    amount: 9007199254740995n,
    currency: "ZAR",
    authorization: { authorization_code: "AUTH", card_number: "never retain" },
    customer: { customer_code: "CUS" },
  });
  assert.equal(verified.provider_transaction_id, "9007199254740993");
  assert.equal(verified.amount_minor, 9007199254740995n);
  const decimal = parseVerifiedTransaction(
    parseCanonicalJson('{"reference":"r","id":1.0,"amount":1.0}'),
  );
  assert.equal(decimal.provider_transaction_id, "1.0");
  assert.equal(decimal.amount_minor, null);
  assert.equal("card_number" in verified, false);
  assert.equal(
    provider.parseWebhook({
      event: "charge.success",
      data: { status: "failed" },
    }).kind,
    "ignored",
  );
  assert.throws(() =>
    provider.parseWebhook({ event: "subscription.disable", data: {} }),
  );
  assert.deepEqual(internalSubscriptionState("non-renewing"), ["ACTIVE", true]);
  assert.equal(internalSubscriptionState("paused"), undefined);
  assert.equal(
    parseVerifiedSubscription({ subscription_code: "SUB", status: "attention" })
      .state,
    "attention",
  );
  assert.equal(mergeEntitlementValue(3n, 9007199254740993n), 9007199254740993n);
  assert.equal(mergeEntitlementValue(true, false), true);
});
test("Paystack local HTTP fixtures accept successful empty mutation responses", async () => {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    calls.push(request.url!);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url!.startsWith("/subscription/") &&
          !request.url!.endsWith("/disable")
          ? { status: true, data: { email_token: "local-token" } }
          : { status: true, data: null },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    await new PaystackProvider(
      "local-secret",
      `http://127.0.0.1:${address.port}`,
    ).setSubscriptionEnabled("SUB/encoded", false);
    assert.deepEqual(calls, [
      "/subscription/SUB%2Fencoded",
      "/subscription/disable",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test(
  "isolated PostgreSQL ledger, referral and checkout state transitions",
  { skip: !process.env.CORE_BILLING_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_BILLING_TEST_DATABASE_URL!,
      schema = `billing_test_${randomUUID().replaceAll("-", "")}`,
      admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    try {
      // Explicit cloning reads schemas only; every test query resolves exclusively inside this schema.
      for (const name of [
        "BillingInterval",
        "OrganizationSubscriptionStatus",
        "EntitlementSource",
      ]) {
        const result = await admin.query(
          "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=enumtypid JOIN pg_namespace ON pg_namespace.oid=typnamespace WHERE pg_namespace.nspname='public' AND typname=$1 ORDER BY enumsortorder",
          [name],
        );
        await pool.query(
          `CREATE TYPE "${name}" AS ENUM (${result.rows.map((row) => "'" + String(row.enumlabel).replaceAll("'", "''") + "'").join(",")})`,
        );
      }
      for (const name of [
        "User",
        "Organization",
        "CreditAccount",
        "CreditGrant",
        "CreditLedgerEntry",
        "CreditReservation",
        "CreditUsageEvent",
        "CreditAdminOperation",
        "ReferralCode",
        "ReferralAttribution",
        "Product",
        "ProductPlan",
        "PlanEntitlement",
        "OrganizationSubscription",
        "OrganizationEntitlementGrant",
        "BillingCheckout",
        "BillingInvoice",
        "BillingReconciliationIssue",
        "PaystackWebhookEvent",
        "UsageEvent",
      ]) {
        await pool.query(
          `CREATE TABLE "${name}" (LIKE public."${name}" INCLUDING ALL)`,
        );
      }
      for (const [table, column, type] of [
        ["ProductPlan", "interval", "BillingInterval"],
        [
          "OrganizationSubscription",
          "status",
          "OrganizationSubscriptionStatus",
        ],
        ["OrganizationEntitlementGrant", "source", "EntitlementSource"],
      ]) {
        await pool.query(
          `ALTER TABLE "${table}" ALTER COLUMN "${column}" DROP DEFAULT; ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE "${type}" USING "${column}"::text::"${type}"`,
        );
      }
      await pool.query(
        `INSERT INTO "User"(id,name,email,"createdAt","updatedAt") VALUES('owner','Owner','owner@example.test',NOW(),NOW()),('friend','Friend','friend@example.test',NOW(),NOW()); INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org','Org','org','owner',NOW(),NOW()),('referrer','Referrer','referrer','friend',NOW(),NOW())`,
      );
      const grants = await Promise.all([
        grantSystemCredits(
          pool,
          "org",
          9007199254741000n,
          "TRIAL",
          new Date(Date.now() + 86400000),
          "Synthetic trial",
          null,
          null,
          "trial-org",
        ),
        grantSystemCredits(
          pool,
          "org",
          9007199254741000n,
          "TRIAL",
          new Date(Date.now() + 86400000),
          "Synthetic trial",
          null,
          null,
          "trial-org",
        ),
      ]);
      assert.equal(grants.filter((row) => row.idempotent === false).length, 1);
      assert.equal(
        (await getCreditAccount(pool, "org")).balance,
        9007199254741000n,
      );
      const reservations = await Promise.all([
        reserveCredits(
          pool,
          "org",
          "test.action",
          100n,
          "test",
          "source",
          null,
          null,
          "reserve",
        ),
        reserveCredits(
          pool,
          "org",
          "test.action",
          100n,
          "test",
          "source",
          null,
          null,
          "reserve",
        ),
      ]);
      const reservation = reservations[0].reservation as { id: string };
      assert.equal(
        reservations.filter((row) => row.idempotent === false).length,
        1,
      );
      await captureCredits(
        pool,
        "org",
        reservation.id,
        80n,
        {
          input_tokens: 9007199254740993n,
          provider_cost_usd: "0.123456789012345678",
        },
        "capture",
      );
      await captureCredits(pool, "org", reservation.id, 80n, {}, "capture");
      assert.equal(
        BigInt(
          (await getCreditAccount(pool, "org")).balance as number | bigint,
        ),
        9007199254740920n,
      );
      assert.equal((await getCreditAccount(pool, "org")).reservedBalance, 0);
      await assert.rejects(
        releaseCredits(pool, "org", reservation.id, "done", "invalid-release"),
        /already captured/,
      );
      const release = await reserveCredits(
        pool,
        "org",
        "test.action",
        20n,
        "test",
        "release",
        null,
        null,
        "reserve-release",
      );
      await releaseCredits(
        pool,
        "org",
        (release.reservation as { id: string }).id,
        "cancelled",
        "release",
      );
      assert.equal((await getCreditAccount(pool, "org")).reservedBalance, 0);
      const code = await ensureReferralCode(pool, "referrer");
      await attributeReferral(pool, "org", code, rewards);
      await Promise.all([
        qualifyReferral(pool, "org", "payment", rewards),
        qualifyReferral(pool, "org", "payment", rewards),
      ]);
      assert.equal(
        (await pool.query('SELECT status FROM "ReferralAttribution"')).rows[0]
          .status,
        "AWARDED",
      );
      assert.equal((await getCreditAccount(pool, "referrer")).balance, 1000);
      await reverseReferral(pool, "org", "Synthetic refund", "refund");
      assert.equal((await getCreditAccount(pool, "referrer")).balance, 0);
      await pool.query(
        `INSERT INTO "Product"(id,key,name,active,"createdAt","updatedAt") VALUES('product','workspace','Workspace',true,NOW(),NOW()); INSERT INTO "ProductPlan"(id,"productId",key,name,interval,currency,"amountMinor","creditsPerPeriod",active,"paystackPlanCode","createdAt","updatedAt") VALUES('plan','product','workspace-pro','Pro','MONTHLY','ZAR',5000,100,true,'PLN',NOW(),NOW());`,
      );
      let initialized = 0;
      let paymentReference = "";
      const provider: BillingProvider = {
        name: "paystack",
        async initializeCheckout(input) {
          initialized++;
          paymentReference = input.reference;
          return {
            authorization_url: "http://127.0.0.1/synthetic-payment",
            reference: input.reference,
          };
        },
        async verifyTransaction(reference) {
          return {
            successful: true,
            reference,
            amount_minor: 5000n,
            currency: "ZAR",
            customer_id: "CUS",
            subscription_id: "SUB",
            provider_transaction_id: "TX",
            provider_authorization_id: "AUTH",
          };
        },
        async verifySubscription(id) {
          return {
            subscription_id: id,
            state: "non-renewing",
            current_period_start: null,
            current_period_end: null,
            provider_invoice_id: "INV",
          };
        },
        async setSubscriptionEnabled() {},
        verifyWebhook() {
          return true;
        },
        parseWebhook() {
          return { kind: "ignored" };
        },
      };
      await createCheckout(
        pool,
        provider,
        "http://localhost:3000",
        "org",
        "owner",
        "owner@example.test",
        "workspace-pro",
        "checkout",
      );
      await createCheckout(
        pool,
        provider,
        "http://localhost:3000",
        "org",
        "owner",
        "owner@example.test",
        "workspace-pro",
        "checkout",
      );
      assert.equal(initialized, 1);
      assert.equal(
        (await verifyCheckout(pool, provider, "org", paymentReference, rewards))
          .activated,
        true,
      );
      await verifyCheckout(pool, provider, "org", paymentReference, rewards);
      assert.equal(
        (await pool.query('SELECT COUNT(*) FROM "BillingInvoice"')).rows[0]
          .count,
        "1",
      );
      await Promise.all([
        processRecurringCharge(
          pool,
          "paystack",
          "recurring",
          "SUB",
          "TX2",
          "INV2",
          5000n,
          "ZAR",
        ),
        processRecurringCharge(
          pool,
          "paystack",
          "recurring",
          "SUB",
          "TX2",
          "INV2",
          5000n,
          "ZAR",
        ),
      ]);
      assert.equal(
        (await pool.query('SELECT COUNT(*) FROM "BillingInvoice"')).rows[0]
          .count,
        "2",
      );
      assert.equal((await getBillingSummary(pool, "org")).orgId, "org");
      assert.equal(
        ((await getBillingUsage(pool, "org", 7)).daily as unknown[]).length,
        7,
      );
      const reconciled = await reconcileBilling(pool, provider, 20, rewards);
      assert.equal(reconciled.subscriptionsUpdated, 1);
      await processProviderEvent(
        pool,
        "paystack",
        { kind: "subscription_disabled", subscription_id: "SUB" },
        rewards,
      );
      assert.equal(
        (await pool.query('SELECT status FROM "OrganizationSubscription"'))
          .rows[0].status,
        "CANCELLED",
      );
      await pool.query(
        'UPDATE "CreditGrant" SET "endsAt"=NOW()-INTERVAL \'1 second\' WHERE "orgId"=\'org\'',
      );
      await expireCreditGrants(pool, "org");
      assert.equal((await getCreditAccount(pool, "org")).balance, 0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test("HTTP billing/referral authentication and signed raw webhook isolation", async () => {
  const app = Fastify();
  await app.register(cookie);
  installErrorHandler(app);
  const context = {
    config: readConfig({
      DATABASE_URL: "postgres://unused",
      PAYSTACK_SECRET_KEY: "synthetic-secret",
    }),
    pool: {
      async query() {
        return { rows: [{ id: "event" }], rowCount: 1 };
      },
    },
  } as unknown as CoreContext;
  registerBillingRoutes(app, context);
  registerReferralRoutes(app, context);
  await app.ready();
  try {
    for (const url of [
      "/api/billing/summary",
      "/api/billing/plans",
      "/api/referrals",
    ])
      assert.equal((await app.inject({ url })).statusCode, 401);
    const raw = '{ "event": "synthetic.ignored", "data": { "id": 1 } }',
      signature = createHmac("sha512", "synthetic-secret")
        .update(raw)
        .digest("hex");
    const response = await app.inject({
      method: "POST",
      url: "/api/webhooks/paystack",
      headers: {
        "content-type": "application/json",
        "x-paystack-signature": signature,
      },
      payload: raw,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { received: true, processed: false });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/webhooks/paystack",
          headers: {
            "content-type": "application/json",
            "x-paystack-signature": signature,
          },
          payload: raw.replace("{ ", "{"),
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
