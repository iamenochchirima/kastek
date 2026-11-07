import test from "node:test";
import assert from "node:assert/strict";
import {
  betaPackageSnapshot,
  boundedText,
  packageParameters,
  transitionAllowed,
} from "../src/services/early-access.js";

test("early-access package validation and lifecycle transitions", () => {
  assert.equal(transitionAllowed("new", "active"), false);
  assert.equal(transitionAllowed("rejected", "approved"), false);
  assert.equal(transitionAllowed("revoked", "invited"), true);
  assert.equal(transitionAllowed("active", "expired"), true);
  assert.deepEqual(packageParameters(betaPackageSnapshot()), {
    durationDays: 30,
  });
  assert.throws(
    () => packageParameters({ ...betaPackageSnapshot(), durationDays: 1.5 }),
    /duration is invalid/,
  );
  assert.throws(() => boundedText("éé", "Name", 3), /at most 3 characters/);
});
