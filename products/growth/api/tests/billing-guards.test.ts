import test from "node:test";
import assert from "node:assert/strict";
import { requireAiCredit, requireCapability, requireResourceLimit } from "../src/services/billing.js";
import { analyticsQueryNeedsPlan } from "../src/routes/analytics.js";

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
