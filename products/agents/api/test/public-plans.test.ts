import { createServer, type Server } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerBillingRoutes } from "../src/product/billing/routes";

const serviceSecret = "agents-public-plans-secret-000000000000";
const snapshotSecret = "agents-public-plans-snapshot-000000000000";
const previousEnv = {
  BILLING_SERVICE_URL: process.env.BILLING_SERVICE_URL,
  BILLING_SERVICE_SECRET: process.env.BILLING_SERVICE_SECRET,
  BILLING_SNAPSHOT_SECRET: process.env.BILLING_SNAPSHOT_SECRET,
  BILLING_SERVICE_TIMEOUT_MS: process.env.BILLING_SERVICE_TIMEOUT_MS,
};

let server: Server;
let app: FastifyInstance;
let failPlans = false;

function planPayload() {
  return {
    key: "agents-public-test",
    name: "Agents Public Test",
    description: "Public test plan",
    product: "agents",
    version: 3,
    versionId: "pv_agents_public",
    status: "active",
    interval: "monthly",
    currency: "ZAR",
    amountMinor: "35000",
    taxInclusive: true,
    taxRateBps: 1500,
    grossAmountMinor: "35000",
    creditsPerPeriod: "10000000",
    checkoutReady: true,
    effectiveFrom: new Date().toISOString(),
    effectiveTo: null,
    notes: "internal note",
    entitlements: [
      {
        key: "agents.feature.manage",
        value: true,
        kind: "feature",
        name: "Agents workspace",
        description: null,
        unit: null,
        metadata: { enforcement: "hard", internal: "secret" },
        implementationStatus: "implemented",
        visibleToCustomer: true,
        displayGroup: "Features",
        displayOrder: 1,
      },
      {
        key: "agent_tokens",
        value: 500000,
        kind: "meter",
        name: "Agent tokens",
        description: null,
        unit: "tokens",
        metadata: { internal: "secret" },
        implementationStatus: "implemented",
        visibleToCustomer: true,
        displayGroup: "Usage",
        displayOrder: 1,
      },
      {
        key: "internal.hidden",
        value: true,
        kind: "feature",
        name: "Internal hidden",
        description: null,
        unit: null,
        metadata: {},
        implementationStatus: "implemented",
        visibleToCustomer: false,
        displayGroup: "Features",
        displayOrder: 2,
      },
    ],
  };
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/internal/plans") {
      if (failPlans) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      response.end(JSON.stringify({ plans: [planPayload()] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
  process.env.BILLING_SERVICE_URL = `http://127.0.0.1:${address.port}`;
  process.env.BILLING_SERVICE_SECRET = serviceSecret;
  process.env.BILLING_SNAPSHOT_SECRET = snapshotSecret;
  process.env.BILLING_SERVICE_TIMEOUT_MS = "3000";
  app = Fastify();
  registerBillingRoutes(app, {
    pool: {} as Pool,
    publicUrl: "http://localhost:3100",
    resolveScope: async () => ({ accountId: "account", organizationId: "org" }),
  });
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Agents public plans", () => {
  it("returns only customer-visible plan data", async () => {
    failPlans = false;
    const response = await app.inject({ method: "GET", url: "/api/public/plans" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toMatch(/^public,/);
    expect(response.headers["cache-control"]).toContain("max-age=60");
    const body = response.json() as {
      configured: boolean;
      plans: Array<Record<string, unknown> & { entitlements: Array<Record<string, unknown>> }>;
    };
    expect(body.configured).toBe(true);
    const plan = body.plans.find((item) => item.key === "agents-public-test");
    expect(plan).toBeTruthy();
    expect(plan?.amountMinor).toBe("35000");
    expect(plan?.creditsPerPeriod).toBe("10000000");
    expect(plan?.checkoutReady).toBe(true);
    expect(plan?.entitlements.map((item) => item.key)).toEqual([
      "agents.feature.manage",
      "agent_tokens",
    ]);
    expect(plan?.entitlements[1]?.kind).toBe("limit");
    for (const item of plan?.entitlements ?? []) {
      expect("metadata" in item).toBe(false);
      expect("implementationStatus" in item).toBe(false);
    }
    const raw = JSON.stringify(body);
    for (const forbidden of [
      "paystackPlanCode",
      "versionId",
      "tenantId",
      "metadata",
      "internal.hidden",
      "internal note",
    ])
      expect(raw).not.toContain(forbidden);
  });

  it("returns an empty unconfigured response when billing fails", async () => {
    failPlans = true;
    const response = await app.inject({ method: "GET", url: "/api/public/plans" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ configured: false, plans: [] });
    expect(response.headers["cache-control"]).toContain("max-age=60");
  });
});
