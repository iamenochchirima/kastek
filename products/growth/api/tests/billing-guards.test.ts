import test from "node:test";
import assert from "node:assert/strict";
import { requireAiCredit, requireCapability, requireMeterAvailable, requireResourceLimit } from "../src/services/billing.js";
import { analyticsQueryNeedsPlan } from "../src/routes/analytics.js";
import { runBillingUsageForwarder } from "../src/workers/billing-usage-forwarder.js";

test("seat and channel guards allow within the plan and deny above it", async () => {
  await requireResourceLimit(null as never, "org-guard", "limit.team_seats", 2);
  await assert.rejects(
    requireResourceLimit(null as never, "org-guard", "limit.team_seats", 3),
    /team seats limit/,
  );
  await assert.rejects(
    requireResourceLimit(null as never, "org-guard", "limit.connected_channels", 1),
    /connected channels limit/,
  );
});

test("AI allowance stays available until the credit balance reaches zero", async () => {
  await requireAiCredit(null as never, "org-credit");
  await assert.rejects(
    requireAiCredit(null as never, "zero-credit"),
    /AI usage allowance is used up/,
  );
});

test("meter guards compare decimal snapshot usage without throwing", async () => {
  await requireMeterAvailable(null as never, "meter-under-limit", "social_publishes", 1);
  await assert.rejects(
    requireMeterAvailable(null as never, "meter-at-limit", "social_publishes", 1),
    /social_publishes monthly limit/,
  );
});

test("content capabilities deny missing plan features", async () => {
  await requireCapability(null as never, "business", "feature.content.manage");
  await assert.rejects(
    requireCapability(null as never, "business-denied", "feature.content.manage"),
    /not included/,
  );
  await assert.rejects(
    requireCapability(null as never, "business", "feature.content.publish"),
    /not included/,
  );
  await requireCapability(null as never, "org-content", "feature.content.publish");
});

test("billing guards and the usage forwarder are disabled when central billing is not configured", async () => {
  const keys = [
    "BILLING_SERVICE_URL",
    "BILLING_SERVICE_SECRET",
    "BILLING_SNAPSHOT_SECRET",
  ] as const;
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  try {
    await requireCapability(null as never, "org", "feature.content.manage");
    await requireResourceLimit(null as never, "org", "limit.connected_channels", 100);
    await requireMeterAvailable(null as never, "org", "social_publishes", 100);
    await requireAiCredit(null as never, "org");

    const warnings: Record<string, unknown>[] = [];
    await runBillingUsageForwarder(
      null as never,
      null as never,
      {
        info() {},
        warn(fields) {
          warnings.push(fields);
        },
        error() {},
      },
      new AbortController().signal,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.reason, "billing_not_configured");
  } finally {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("overview analytics stays free while full reports require the plan", () => {
  const base = {
    range_start: "2026-11-01T00:00:00.000Z",
    range_end: "2026-11-09T00:00:00.000Z",
    timezone: "UTC",
    metrics: [],
    breakdowns: [],
    filters: {},
    include_descendants: false,
  };
  assert.equal(
    analyticsQueryNeedsPlan({ ...base, metric_set: "overview.summary@1" }),
    false,
  );
  assert.equal(
    analyticsQueryNeedsPlan({
      ...base,
      metric_set: "overview.summary@1",
      metrics: ["conversation.messages.received@1"],
    }),
    true,
  );
  assert.equal(
    analyticsQueryNeedsPlan({ ...base, metric_set: "campaign.delivery@1" }),
    true,
  );
  assert.equal(analyticsQueryNeedsPlan(base), true);
});
