import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { readConfig } from "../src-ts/config.js";
import { buildApp } from "../src-ts/app.js";
import { registerAnalyticsRoutes } from "../src-ts/routes/analytics.js";

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
