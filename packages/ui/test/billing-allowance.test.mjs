import assert from "node:assert/strict";
import test from "node:test";
import { billingAllowance } from "../dist/billing-allowance.js";

test("warns at 80% and stops at 100%", () => {
  assert.deepEqual(billingAllowance({ used: 79, available: 21 }), {
    total: 100,
    percent: 79,
    exhausted: false,
    approaching: false,
  });
  assert.deepEqual(billingAllowance({ used: 80, available: 20 }), {
    total: 100,
    percent: 80,
    exhausted: false,
    approaching: true,
  });
  assert.deepEqual(billingAllowance({ used: 100, available: 0 }), {
    total: 100,
    percent: 100,
    exhausted: true,
    approaching: false,
  });
});

test("a grant restores the available balance immediately", () => {
  assert.deepEqual(billingAllowance({ used: 100, available: 50 }), {
    total: 150,
    percent: 67,
    exhausted: false,
    approaching: false,
  });
});

test("a zero allowance is not reported as exhausted usage", () => {
  assert.deepEqual(billingAllowance({ used: 0, available: 0 }), {
    total: 0,
    percent: 0,
    exhausted: false,
    approaching: false,
  });
});
