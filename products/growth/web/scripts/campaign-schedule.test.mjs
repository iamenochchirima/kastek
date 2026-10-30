import assert from "node:assert/strict";
import test from "node:test";
import { scheduledInstants } from "../src/components/dashboard/campaigns/campaign-create-utils.ts";

test("resolves a Johannesburg wall clock to an unambiguous UTC instant", () => {
  assert.deepEqual(scheduledInstants("2030-06-15T10:00", "Africa/Johannesburg"), ["2030-06-15T08:00:00.000Z"]);
});
test("rejects nonexistent local times during a daylight saving transition", () => {
  assert.deepEqual(scheduledInstants("2030-03-10T02:30", "America/New_York"), []);
});
test("returns both repeated local-time occurrences for explicit selection", () => {
  assert.deepEqual(scheduledInstants("2030-11-03T01:30", "America/New_York"), ["2030-11-03T05:30:00.000Z", "2030-11-03T06:30:00.000Z"]);
});
test("rejects invalid calendar dates and unknown time zones", () => {
  assert.deepEqual(scheduledInstants("2030-02-30T10:00", "UTC"), []);
  assert.deepEqual(scheduledInstants("2030-06-15T10:00", "Missing/Timezone"), []);
});
test("handles fractional-hour offsets", () => {
  assert.deepEqual(scheduledInstants("2030-06-15T10:00", "Pacific/Chatham"), ["2030-06-14T21:15:00.000Z"]);
});
