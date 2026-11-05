import test from "node:test";
import assert from "node:assert/strict";
import { reviewedRecipientLabel } from "../src/operations/review-recipient.js";

test("reviewed message recipient requires a recognizable recipient", () => {
  assert.equal(reviewedRecipientLabel({ name: "Maria", identifier: "+27123456789", channel: "WhatsApp" }),
    "Maria · +27123456789 · WhatsApp");
  assert.equal(reviewedRecipientLabel({ identifier: "+27123456789", channel: "WhatsApp" }), "+27123456789 · WhatsApp");
  assert.equal(reviewedRecipientLabel({ name: " Maria ", channel: "WhatsApp" }), " Maria  · WhatsApp");
  assert.equal(reviewedRecipientLabel({ name: " ", channel: "WhatsApp" }), null);
  assert.equal(reviewedRecipientLabel(undefined), null);
});
