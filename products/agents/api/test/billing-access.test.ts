import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BillingEntitlementSnapshot } from "@kasitek-labs/contracts";
import { billingSnapshotToken } from "@kasitek-labs/server-support/billing-authority";
import { assertAgentsBillingAccess } from "../src/product/billing/billing";

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
    plan: { key: "agents-growth", name: "Growth", version: 2 },
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
    availableCredits = "1000000";
    await expect(
      assertAgentsBillingAccess(pool, "org_credit"),
    ).resolves.toBeUndefined();
  });

  it("denies work when the credit balance is exhausted", async () => {
    availableCredits = "0";
    await expect(
      assertAgentsBillingAccess(pool, "org_exhausted"),
    ).rejects.toMatchObject({
      code: "BILLING_AI_ALLOWANCE_EXHAUSTED",
      statusCode: 403,
    });
  });

  it("restores access as soon as credit is granted", async () => {
    availableCredits = "1000000";
    await expect(
      assertAgentsBillingAccess(pool, "org_exhausted"),
    ).resolves.toBeUndefined();
  });
});
