import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BillingEntitlementSnapshot } from "@kasitek-labs/contracts";
import { billingSnapshotToken } from "@kasitek-labs/server-support/billing-authority";
import { assertAgentsBillingAccess, assertAgentsPaidPlan, assertManagedModelAllowance, agentsPaidModelsAllowed, billingPaidPlan } from "../src/product/billing/billing";
import { BillingClient } from "@kasitek-labs/server-support/billing-client";

const serviceSecret = "agents-test-billing-secret-0000000000000";
const snapshotSecret = "agents-test-snapshot-secret-000000000000";
const pool = {
  query: async () => ({
    rows: [
      {
        name: "Test workspace",
        email: "owner@example.test",
        issuer: "https://identity.test",
        subject: "owner",
      },
    ],
  }),
} as unknown as Pool;

let server: Server;
let url: string;
let availableCredits = "1000000";
let planKey = "agents-growth";
const previousEnv = { ...process.env };

function snapshot(tenantId: string): BillingEntitlementSnapshot {
  const issuedAt = new Date();
  return {
    version: 1,
    accountId: `acct_${tenantId}`,
    product: "agents",
    tenantId,
    revision: "1",
    access: "active",
    plan: { key: planKey, name: planKey, version: 2 },
    subscription: {
      id: `sub_${tenantId}`,
      product: "agents",
      planKey: "agents-growth",
      planName: "Growth",
      planVersion: 2,
      status: "active",
      currentPeriodStart: issuedAt.toISOString(),
      currentPeriodEnd: new Date(issuedAt.getTime() + 30 * 86_400_000).toISOString(),
      trialEndsAt: null,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
      provider: null,
    },
    features: { "agents.feature.manage": true },
    limits: { "limit.agent_seats": 10 },
    meters: {
      // A stale token cap from an older plan version must not block access.
      agent_tokens: { used: "12500000", limit: "12500000" },
    },
    credits: {
      balance: availableCredits,
      reserved: "0",
      available: availableCredits,
      currency: "USD",
    },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 300_000).toISOString(),
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    const incoming = new URL(request.url ?? "/", "http://localhost");
    const send = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (incoming.pathname === "/internal/accounts/ensure")
      return send({
        accountId: "acct_org_credit",
        product: "agents",
        tenantId: "org_credit",
        revision: "1",
      });
    if (incoming.pathname === "/internal/entitlements") {
      const tenantId = incoming.searchParams.get("tenantId") ?? "org_credit";
      const value = snapshot(tenantId);
      return send({
        snapshot: value,
        token: billingSnapshotToken(value, snapshotSecret),
      });
    }
    if (incoming.pathname === "/internal/checkout") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: '"email" must be a valid email' }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Billing fixture failed to listen");
  url = `http://127.0.0.1:${address.port}`;
  process.env.AGENTS_BILLING_ENFORCEMENT = "true";
  process.env.BILLING_SERVICE_URL = url;
  process.env.BILLING_SERVICE_SECRET = serviceSecret;
  process.env.BILLING_SNAPSHOT_SECRET = snapshotSecret;
});

afterAll(async () => {
  process.env = previousEnv;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("Agents AI allowance access", () => {
  it("allows work while credit is available and ignores a stale token cap", async () => {
    planKey = "agents-growth";
    availableCredits = "1000000";
    await expect(
      assertAgentsBillingAccess(pool, "org_credit"),
    ).resolves.toMatchObject({ credits: { available: "1000000" } });
  });

  it("stops managed models at zero without blocking customer keys", async () => {
    planKey = "agents-growth";
    availableCredits = "0";
    const snapshot = await assertAgentsBillingAccess(pool, "org_exhausted");
    expect(() => assertManagedModelAllowance(snapshot, "platform_managed")).toThrow(
      expect.objectContaining({ code: "BILLING_AI_ALLOWANCE_EXHAUSTED", statusCode: 403 }),
    );
    expect(() => assertManagedModelAllowance(snapshot, "user_supplied")).not.toThrow();
  });

  it("restores access as soon as credit is granted", async () => {
    planKey = "agents-growth";
    availableCredits = "1000000";
    await expect(
      assertAgentsBillingAccess(pool, "org_exhausted"),
    ).resolves.toMatchObject({ credits: { available: "1000000" } });
  });

  it("treats the free plan as unpaid and every other plan as paid", async () => {
    planKey = "agents-free";
    const free = await assertAgentsBillingAccess(pool, "org_free");
    expect(free && billingPaidPlan(free)).toBe(false);
    planKey = "agents-starter";
    const paid = await assertAgentsBillingAccess(pool, "org_paid");
    expect(paid && billingPaidPlan(paid)).toBe(true);
  });

  it("allows customer provider keys on paid plans only", async () => {
    planKey = "agents-free";
    await expect(
      assertAgentsPaidPlan(pool, "org_free"),
    ).rejects.toMatchObject({ code: "BILLING_PLAN_REQUIRED", statusCode: 403 });
    planKey = "agents-starter";
    await expect(assertAgentsPaidPlan(pool, "org_paid")).resolves.toBeUndefined();
  });

  it("hides paid managed models from the free picker", async () => {
    planKey = "agents-free";
    await expect(agentsPaidModelsAllowed(pool, "org_free")).resolves.toBe(false);
    planKey = "agents-growth";
    await expect(agentsPaidModelsAllowed(pool, "org_growth")).resolves.toBe(true);
  });

  it("keeps the payment provider's rejection status instead of a generic failure", async () => {
    const client = BillingClient.fromEnvironment("agents")!;
    await expect(
      client.checkout({
        tenantId: "org_credit",
        planKey: "agents-starter",
        email: "owner@example.test",
        idempotencyKey: "checkout-rejected",
        returnUrl: "http://localhost:3150/app/settings?payment=complete",
      }),
    ).rejects.toMatchObject({
      name: "BillingRequestError",
      status: 400,
      message: '"email" must be a valid email',
    });
  });
});
