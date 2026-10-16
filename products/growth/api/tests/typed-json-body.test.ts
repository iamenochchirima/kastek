import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { CORE_REGISTRARS } from "../src/main.js";
import { GENERATED_SERDE_BODY_SCHEMAS } from "../src/identity/json-body-schemas.generated.js";
import { registerAnalyticsRoutes } from "../src/routes/analytics.js";

test("typed request bodies reject duplicate fields before effects; Value bodies keep last value", async () => {
  let effects = 0;
  const app = await buildApp(
    {
      config: readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent" }),
      pool: {} as Pool,
    },
    [
      (server) => {
        server.post(
          "/typed-json",
          {
            schema: {
              body: {
                type: "object",
                properties: { token: { type: "string" } },
              },
            },
          },
          () => {
            effects++;
            return { ok: true };
          },
        );
        server.post("/value-json", (request) => {
          effects++;
          return request.body;
        });
      },
      (server, core) => registerAnalyticsRoutes(server, core),
    ],
  );
  try {
    const duplicate = await app.inject({
      method: "POST",
      url: "/typed-json",
      headers: { "content-type": "application/json" },
      payload: '{"token":"first","token":"second"}',
    });
    assert.equal(duplicate.statusCode, 400);
    assert.match(duplicate.body, /duplicate field `token`/);
    assert.equal(effects, 0);

    const value = await app.inject({
      method: "POST",
      url: "/value-json",
      headers: { "content-type": "application/json" },
      payload: '{"key":"first","key":"last"}',
    });
    assert.equal(value.statusCode, 200);
    assert.deepEqual(value.json(), { key: "last" });
    assert.equal(effects, 1);

    const duplicateReportField = await app.inject({
      method: "POST",
      url: "/api/analytics/query",
      headers: { "content-type": "application/json" },
      payload: '{"range_start":"first","range_start":"second"}',
    });
    assert.equal(duplicateReportField.statusCode, 400);
    assert.match(duplicateReportField.body, /duplicate field `range_start`/);

    const repeatedFilterMapKey = await app.inject({
      method: "POST",
      url: "/api/analytics/query",
      headers: { "content-type": "application/json" },
      payload:
        '{"range_start":"2026-01-01T00:00:00Z","range_end":"2026-02-01T00:00:00Z","timezone":"UTC","filters":{"channel":["first"],"channel":["last"]}}',
    });
    assert.equal(repeatedFilterMapKey.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("source-shaped fallback checks schema-less DTOs and preserves map values", async () => {
  const app = await buildApp(
    {
      config: readConfig({
        DATABASE_URL: "postgres://unused",
        FRONTEND_URL: "http://localhost:3000",
        AGENTS_API_URL: "http://127.0.0.1:4100",
        AGENTS_INTERNAL_AUTH_SECRET: "fixture",
        LOG_LEVEL: "silent",
      }),
      pool: {} as Pool,
    },
    CORE_REGISTRARS,
  );
  try {
    for (const [routeKey, rawSchema] of Object.entries(
      GENERATED_SERDE_BODY_SCHEMAS,
    )) {
      const separator = routeKey.indexOf(" ");
      const method = routeKey.slice(0, separator) as
        | "DELETE"
        | "PATCH"
        | "POST"
        | "PUT";
      const path = routeKey.slice(separator + 1).replace(/:[^/]+/g, "fixture");
      const schema = rawSchema as {
        properties?: Record<string, unknown>;
      };
      const field = Object.keys(schema.properties ?? {})[0];
      assert.ok(field, `${routeKey} has a DTO field for duplicate checking`);
      const duplicateBody =
        "{" +
        JSON.stringify(field) +
        ':"first",' +
        JSON.stringify(field) +
        ':"second"}';
      const response = await app.inject({
        method,
        url: path,
        headers: { "content-type": "application/json" },
        payload: duplicateBody,
      });
      assert.equal(response.statusCode, 400, routeKey);
      assert.match(response.body, /duplicate field `/, routeKey);
    }

    const duplicateRootField = await app.inject({
      method: "POST",
      url: "/api/internal/agents/v1/content/posts",
      headers: { "content-type": "application/json" },
      payload: '{"title":"first","title":"second"}',
    });
    assert.equal(duplicateRootField.statusCode, 400);
    assert.match(duplicateRootField.body, /duplicate field `title`/);

    const duplicateNestedField = await app.inject({
      method: "POST",
      url: "/api/internal/agents/v1/content/posts",
      headers: { "content-type": "application/json" },
      payload:
        '{"variants":[{"platform":"instagram","content":"caption","aiGenerated":true,"aiGenerated":false}]}',
    });
    assert.equal(duplicateNestedField.statusCode, 400);
    assert.match(duplicateNestedField.body, /duplicate field `aiGenerated`/);

    const repeatedMapKey = await app.inject({
      method: "POST",
      url: "/api/internal/agents/v1/content/posts",
      headers: { "content-type": "application/json" },
      payload:
        '{"channelSelections":{"instagram":"first","instagram":"last"}}',
    });
    assert.equal(repeatedMapKey.statusCode, 401);
  } finally {
    await app.close();
  }
});
