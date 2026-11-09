import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseVerifiedTransaction,
  PaystackProvider,
} from "../src/paystack.js";

test("verified transactions keep the numeric customer id without inventing a subscription code", () => {
  const verified = parseVerifiedTransaction({
    status: "success",
    reference: "ks_test",
    amount: 35000,
    currency: "ZAR",
    id: 123456,
    customer: { customer_code: "CUS_TEST", id: 987654 },
    authorization: { authorization_code: "AUTH_TEST" },
  });
  assert.equal(verified.customerId, "CUS_TEST");
  assert.equal(verified.providerCustomerId, "987654");
  assert.equal(verified.subscriptionId, null);
});

test("subscription resolution finds the active code for the checkout plan", async () => {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    response.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/subscription") {
      assert.equal(url.searchParams.get("customer"), "987654");
      response.end(
        JSON.stringify({
          status: true,
          data: [
            {
              subscription_code: "SUB_OLD",
              status: "non-renewing",
              plan: { plan_code: "PLN_TEST" },
            },
            {
              subscription_code: "SUB_ACTIVE",
              status: "active",
              plan: { plan_code: "PLN_TEST" },
            },
            {
              subscription_code: "SUB_OTHER_PLAN",
              status: "active",
              plan: { plan_code: "PLN_OTHER" },
            },
          ],
        }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
  try {
    const provider = new PaystackProvider(
      "sk_test_fixture",
      `http://127.0.0.1:${address.port}`,
    );
    assert.equal(
      await provider.resolveSubscriptionId({
        providerCustomerId: "987654",
        planCode: "PLN_TEST",
      }),
      "SUB_ACTIVE",
    );
    assert.equal(
      await provider.resolveSubscriptionId({
        providerCustomerId: "987654",
        planCode: "PLN_MISSING",
      }),
      null,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
