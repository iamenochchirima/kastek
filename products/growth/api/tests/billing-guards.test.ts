import test from "node:test";
import assert from "node:assert/strict";
import { requireCapability, requireResourceLimit } from "../src/services/billing.js";

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
