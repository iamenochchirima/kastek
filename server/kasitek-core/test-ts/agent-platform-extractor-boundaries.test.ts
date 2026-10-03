import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src-ts/app.js";
import { readConfig } from "../src-ts/config.js";
import { registerSocialRoutes } from "../src-ts/routes/social.js";
import { registerInboxRoutes } from "../src-ts/routes/inbox.js";
import { registerBillingRoutes } from "../src-ts/routes/billing.js";
import { registerWhatsappWebhookRoutes } from "../src-ts/routes/whatsapp-webhooks.js";
import { validatedQuery } from "../src-ts/services/agent-platform/controller-support.js";
import {
  validateBody,
  queryInteger,
} from "../src-ts/services/admin/validation.js";
import type { CoreContext } from "../src-ts/context.js";
test("actual raw Bytes routes retain source 256KiB limits and accept non-JSON Content-Type before authentication", async () => {
  const context = {
    config: readConfig({
      DATABASE_URL: "postgres://unused",
      LOG_LEVEL: "silent",
      AUTH_TIKTOK_CLIENT_SECRET: "fixture",
      AUTH_META_APP_SECRET: "fixture",
      WHATSAPP_APP_SECRET: "fixture",
      PAYSTACK_SECRET_KEY: "fixture",
    }),
    pool: {
      query: async () => {
        throw new Error("No fixture DB effects permitted");
      },
    },
  } as unknown as CoreContext;
  const app = await buildApp(context, [
    (app, core) => registerSocialRoutes(app, core),
    (app, core) => registerInboxRoutes(app, core),
    (app, core) => registerBillingRoutes(app, core),
    (app, core) => registerWhatsappWebhookRoutes(app, core, {}),
  ]);
  try {
    for (const url of [
      "/api/webhooks/whatsapp",
      "/api/webhooks/meta",
      "/api/webhooks/paystack",
      "/api/webhooks/tiktok",
    ]) {
      const oversized = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.alloc(262_145),
      });
      assert.equal(oversized.statusCode, 413, url);
      assert.equal(oversized.body, "payload reached size limit");
      assert.match(String(oversized.headers["content-type"]), /^text\/plain/);
      const unsigned = await app.inject({
        method: "POST",
        url,
        headers: { "content-type": "text/plain" },
        payload: "{}",
      });
      assert.equal(
        unsigned.statusCode,
        url.includes("/meta") || url.includes("/whatsapp") ? 403 : 401,
        url,
      );
    }
    const deletion = await app.inject({
      method: "DELETE",
      url: "/api/social/posts/fixture",
      headers: { "content-type": "text/plain" },
      payload: '{"deleteFromPlatforms":false}',
    });
    assert.equal(deletion.statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/social/posts/fixture",
          headers: { "content-type": "application/octet-stream" },
          payload: Buffer.alloc(262_145),
        })
      ).statusCode,
      413,
    );
  } finally {
    await app.close();
  }
});
test("framework default misses stay empty and extractor failures stay plain text while AppError remains JSON", async () => {
  const { ApiError } = await import("../src-ts/error.js");
  const context = {
    config: readConfig({
      DATABASE_URL: "postgres://unused",
      LOG_LEVEL: "silent",
    }),
    pool: {},
  } as unknown as CoreContext;
  const app = await buildApp(context, [
    (app) => {
      app.post("/api/waitlist", () => ({ ok: true }));
      app.post(
        "/fixture-dto",
        {
          schema: {
            body: {
              type: "object",
              required: ["name"],
              properties: { name: { type: "string" } },
            },
          },
        },
        () => ({ ok: true }),
      );
      app.get("/fixture-query", (request) =>
        validatedQuery(request, { limit: 32 }),
      );
      app.get("/fixture-admin-query", (request) =>
        queryInteger(
          request.query && (request.query as Record<string, unknown>).limit,
        ),
      );
      app.post("/fixture-admin-body", (request) =>
        validateBody("CreateLeadInput", request.body),
      );
      app.post("/fixture-domain", () => {
        throw new ApiError(429, "rate_limited", "Fixture domain limit");
      });
    },
  ]);
  try {
    for (const [method, url] of [
      ["GET", "/absent"],
      ["POST", "/health"],
      ["HEAD", "/health"],
    ] as const) {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, 404);
      assert.equal(response.body, "");
      assert.equal(response.headers["content-type"], undefined);
    }
    const miss = await app.inject({
      method: "POST",
      url: "/absent",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(miss.statusCode, 404);
    assert.equal(miss.body, "");
    for (const url of [
      "/fixture-query?limit=1.0",
      "/fixture-admin-query?limit=1.0",
    ]) {
      const response = await app.inject({ method: "GET", url });
      assert.equal(response.statusCode, 400);
      assert.match(String(response.headers["content-type"]), /^text\/plain/);
      assert.match(response.body, /^Query deserialize error:/);
    }
    const wrong = await app.inject({ method: "GET", url: "/api/waitlist" });
    assert.equal(wrong.statusCode, 405);
    assert.equal(wrong.headers.allow, "POST");
    assert.equal(wrong.body, "");
    for (const [payload, detail] of [
      ["{x}", "key must be a string at line 1 column 2"],
      ["[1,]", "trailing comma at line 1 column 4"],
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/fixture-dto",
        headers: { "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.match(String(response.headers["content-type"]), /^text\/plain/);
      assert.equal(response.body, `Json deserialize error: ${detail}`);
    }
    for (const payload of ["{}", '{"name":false}']) {
      const response = await app.inject({
        method: "POST",
        url: "/fixture-dto",
        headers: { "content-type": "application/json" },
        payload,
      });
      assert.equal(response.statusCode, 400);
      assert.match(String(response.headers["content-type"]), /^text\/plain/);
      assert.match(response.body, /^Json deserialize error:/);
      if (payload === "{}")
        assert.match(response.body, /missing field `name`/);
      if (payload === '{"name":false}') {
        assert.match(
          response.body,
          /invalid type: a boolean, expected a string/,
        );
        assert.doesNotMatch(response.body, /false/);
      }
    }
    const typed = await app.inject({
      method: "POST",
      url: "/fixture-dto",
      headers: { "content-type": "application/octet-stream" },
      payload: "{}",
    });
    assert.equal(typed.statusCode, 400);
    assert.equal(typed.body, "Content type error");
    const domain = await app.inject({ method: "POST", url: "/fixture-domain" });
    assert.equal(domain.statusCode, 429);
    assert.equal(domain.headers["retry-after"], "60");
    assert.deepEqual(domain.json(), {
      error: "Fixture domain limit",
      code: "rate_limited",
    });
  } finally {
    await app.close();
  }
});
