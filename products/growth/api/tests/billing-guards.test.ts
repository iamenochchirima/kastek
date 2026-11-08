import test from "node:test";
import assert from "node:assert/strict";
import { requireResourceLimit } from "../src/services/billing.js";

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
