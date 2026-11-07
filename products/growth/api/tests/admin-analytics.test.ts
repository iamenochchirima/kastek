import test from "node:test";
import assert from "node:assert/strict";
import {
  reportWindow,
  humanizeKey,
} from "../src/services/admin/analytics.js";
import {
  encodeActivityCursor,
  decodeActivityCursor,
  validateActivityQuery,
} from "../src/services/admin/activity.js";
import { UtcTimestamp } from "../src/db.js";

test("Admin reporting bounds, lossless integer DTOs and microsecond activity cursor contract", () => {
  const w = reportWindow(2n, new Date("2026-10-02T12:34:56Z"));
  assert.equal(w.start.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.throws(() => reportWindow(367));
  assert.equal(
    humanizeKey("whatsapp-message.sent"),
    "Whatsapp Message Sent",
  );
  const cursor = encodeActivityCursor(
    new UtcTimestamp("2026-10-02T12:34:56.123456+00:00", true),
    "event",
  );
  assert.equal(
    decodeActivityCursor(cursor)!.occurredAt.toISOString(),
    "2026-10-02T12:34:56.123456Z",
  );
  assert.equal(decodeActivityCursor("invalid"), null);
  assert.throws(() => validateActivityQuery({ limit: 101 }));
  assert.throws(() => validateActivityQuery({ domain: " " }));
});
