import { createServer, type Server } from "node:http";
import type { BillingEntitlementSnapshot } from "@kasitek-labs/contracts";
import { billingSnapshotToken } from "@kasitek-labs/server-support/billing-authority";

export const TEST_BILLING_SECRET = "growth-test-billing-secret-0000000000000000";
export const TEST_SNAPSHOT_SECRET = "growth-test-snapshot-secret-00000000000000";

const FEATURES = [
  "feature.agents.manage",
  "feature.campaigns.manage",
  "feature.campaigns.send",
  "feature.bookings.access",
  "feature.templates.manage",
  "feature.contacts.access",
  "feature.content.manage",
  "feature.content.publish",
  "feature.analytics.view",
  "feature.inbox.access",
  "agents.feature.manage",
  "agency.feature.agents",
];

function snapshot(product: string, tenantId: string): BillingEntitlementSnapshot {
  const issuedAt = new Date();
  return {
    version: 1,
    accountId: `acct_test_${product}_${tenantId}`,
    product: product as BillingEntitlementSnapshot["product"],
    tenantId,
    revision: "1",
    access: "active",
    plan: { key: `${product}-test`, name: "Test plan", version: 1 },
    subscription: {
      id: `sub_test_${tenantId}`,
      product: product as BillingEntitlementSnapshot["product"],
      planKey: `${product}-test`,
      planName: "Test plan",
      planVersion: 1,
      status: "active",
      currentPeriodStart: issuedAt.toISOString(),
      currentPeriodEnd: new Date(issuedAt.getTime() + 30 * 86_400_000).toISOString(),
      trialEndsAt: null,
      graceEndsAt: null,
      cancelAtPeriodEnd: false,
      provider: null,
    },
    features: Object.fromEntries(
      (tenantId === "business"
        ? ["feature.agents.manage", "feature.content.manage"]
        : tenantId.startsWith("business-denied")
          ? ["feature.agents.manage"]
          : FEATURES
      ).map((key) => [key, true]),
    ),
    limits: {
      "limit.team_seats": 3,
      "limit.connected_channels": 1,
      "limit.agent_deployments": 1_000_000,
      "limit.campaign_recipients": 1_000_000,
      "limit.social_publishes": 1_000_000,
      "limit.public_api_requests": 1_000_000,
      "limit.agent_tokens": 1_000_000_000,
      "limit.agency_agent_commands": 1_000_000,
    },
    meters: {},
    credits: {
      balance: tenantId.startsWith("zero-credit") ? "0" : "1000000",
      reserved: "0",
      available: tenantId.startsWith("zero-credit") ? "0" : "1000000",
      currency: "ZAR",
    },
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + 300_000).toISOString(),
  };
}

export async function startBillingFixture(): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (value: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (request.method === "GET" && url.pathname === "/internal/entitlements") {
      const product = url.searchParams.get("product") ?? "growth";
      const tenantId = url.searchParams.get("tenantId") ?? "org";
      const value = snapshot(product, tenantId);
      return send({
        snapshot: value,
        token: billingSnapshotToken(value, TEST_SNAPSHOT_SECRET),
      });
    }
    if (url.pathname === "/internal/accounts/ensure")
      return send({
        accountId: "acct_test",
        product: "growth",
        tenantId: "org",
        revision: "1",
      });
    if (url.pathname === "/internal/usage")
      return send({
        accepted: true,
        duplicate: false,
        creditsCharged: "0",
        balance: "1000000",
        shortfall: "0",
      });
    if (url.pathname === "/internal/credits/grant")
      return send({ grantId: "grant_test", balance: "1000000", replayed: false });
    if (url.pathname === "/internal/credits/revoke")
      return send({ revoked: "0", balance: "1000000" });
    if (url.pathname === "/internal/checkout")
      return send({
        reference: "ks_test",
        authorizationUrl: "https://pay.example/test",
        planKey: "test",
        reused: false,
      });
    if (url.pathname.startsWith("/internal/checkout/"))
      return send({
        reference: "ks_test",
        status: "completed",
        subscriptionId: "sub_test",
        invoiceId: "inv_test",
      });
    if (url.pathname.startsWith("/internal/subscriptions/"))
      return send({ canceled: true, cancelAtPeriodEnd: false, reactivated: true });
    if (url.pathname === "/internal/plans") return send({ plans: [] });
    if (url.pathname.startsWith("/internal/plans/"))
      return send({
        key: "test",
        name: "Test plan",
        product: "growth",
        version: 1,
        interval: "monthly",
        currency: "ZAR",
        amountMinor: "100",
        taxInclusive: true,
        taxRateBps: 1500,
        grossAmountMinor: "100",
        creditsPerPeriod: "1000",
        checkoutReady: true,
        entitlements: [],
      });
    if (url.pathname === "/internal/account")
      return send({ account: { id: "acct_test" }, links: [], subscriptions: [] });
    if (url.pathname === "/internal/invoices") return send({ invoices: [] });
    if (url.pathname === "/internal/credits")
      return send({
        credits: {
          balance: "1000000",
          reserved: "0",
          available: "1000000",
          currency: "ZAR",
        },
        grants: [],
        ledger: [],
      });
    if (url.pathname === "/internal/usage")
      return send({ meters: [], recent: [] });
    return send({ ok: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Billing fixture failed to listen");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
