import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { Pool } from "pg";
import { registerHealthRoutes } from "../src-ts/health.js";
import { ProcessMetrics } from "../src-ts/metrics.js";

test("liveness stays available while readiness reports database and migration failures", async () => {
  const unavailablePool = {
    async query() {
      throw Error("database credential details must stay private");
    },
  } as unknown as Pool;
  const metrics = new ProcessMetrics(),
    app = Fastify();
  registerHealthRoutes(app, unavailablePool, "analytics-api", metrics);
  try {
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    const unavailable = await app.inject("/health/ready");
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json().dependencies, {
      postgres: { status: "unavailable" },
      migrations: { status: "unavailable" },
    });
    assert.equal(unavailable.body.includes("credential details"), false);
  } finally {
    await app.close();
  }

  const pendingPool = {
    async query(sql: string) {
      return sql === "SELECT 1"
        ? { rows: [{ result: 1 }] }
        : { rows: [{ ready: false }] };
    },
  } as unknown as Pool;
  const pendingApp = Fastify();
  registerHealthRoutes(pendingApp, pendingPool, "analytics-api", metrics);
  try {
    const pending = await pendingApp.inject("/health/ready");
    assert.equal(pending.statusCode, 503);
    assert.deepEqual(pending.json().dependencies, {
      postgres: { status: "ready" },
      migrations: { status: "pending" },
    });
    assert.match(
      metrics.render("analytics-api"),
      /kasitek_analytics_readiness_failures_total\{[^}]+\} 2/,
    );
  } finally {
    await pendingApp.close();
  }
});
