import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { Pool } from "pg";
import { readConfig } from "../src/config.js";
import { registerBillingServiceRoutes } from "../src/routes/billing-service-routes.js";
import { billingServiceConfig } from "../src/services/billing-service.js";

test("public plans expose only customer-visible, non-internal fields", async () => {
  const service = billingServiceConfig(process.env);
  assert.ok(service, "billing fixture must be configured");
  const config = readConfig({
    DATABASE_URL: "postgres://unused",
    ENVIRONMENT: "test",
    LOG_LEVEL: "silent",
  });
  const app = Fastify();
  registerBillingServiceRoutes(app, { config, pool: {} as Pool }, service);
  try {
    const response = await app.inject({ method: "GET", url: "/api/public/plans" });
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.headers["cache-control"] ?? "", /^public,/);
    assert.match(response.headers["cache-control"] ?? "", /max-age=60/);
    assert.equal(response.headers["set-cookie"], undefined);

    const body = response.json() as {
      configured: boolean;
      plans: Array<Record<string, unknown> & { entitlements: Array<Record<string, unknown>> }>;
    };
    assert.equal(body.configured, true);
    const plan = body.plans.find((item) => item.key === "growth-public-test");
    assert.ok(plan, "fixture plan must be returned");
    assert.equal(plan.amountMinor, 35000);
    assert.equal(plan.creditsPerPeriod, 10_000_000);
    assert.equal(plan.checkoutReady, true);
    assert.deepEqual(
      plan.entitlements.map((item) => item.key),
      ["feature.agents.manage", "limit.team_seats"],
    );
    for (const item of plan.entitlements) {
      assert.equal("metadata" in item, false);
      assert.equal("implementationStatus" in item, false);
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
      assert.equal(raw.includes(forbidden), false, `${forbidden} must not be public`);
  } finally {
    await app.close();
  }
});
