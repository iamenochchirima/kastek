import test from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";
import { canonicalJson, SerdeFloat } from "@kasitek-labs/server-support/json";
import {
  parseRequestJson,
  canonicalJsonBody,
  jsonNumberKind,
  validateIntegerTokenSchema,
} from "../src/identity/json-body.js";
test("request JSON keeps primitive typed f64 values while canonical Value boundaries preserve float/integer lexical kinds", () => {
  const request = {} as FastifyRequest;
  const typed = parseRequestJson(
    request,
    '{"plain":1,"decimal":1.0,"exponent":1e0,"negativeZero":-0.0,"large":9223372036854775807}',
  ) as Record<string, unknown>;
  assert.equal(typed.decimal, 1);
  assert.equal(typed.exponent, 1);
  assert.equal(typed.large, 9223372036854775807n);
  assert.equal(jsonNumberKind(request, ["plain"]), "integer");
  assert.equal(jsonNumberKind(request, ["decimal"]), "float");
  assert.equal(jsonNumberKind(request, ["exponent"]), "float");
  assert.ok(
    (canonicalJsonBody(request) as Record<string, unknown>).decimal instanceof
      SerdeFloat,
  );
  assert.equal(
    canonicalJson(canonicalJsonBody(request)),
    '{"decimal":1.0,"exponent":1.0,"large":9223372036854775807,"negativeZero":-0.0,"plain":1}',
  );
});
test("integer token validation rejects integral float tokens without rejecting f64 schemas or null optional integers", () => {
  const request = {} as FastifyRequest;
  parseRequestJson(
    request,
    '{"count":1.0,"cost":1.0,"optional":null,"nested":[{"value":2e0}]}',
  );
  assert.throws(
    () =>
      validateIntegerTokenSchema(request, {
        type: "object",
        properties: { count: { type: "integer" } },
      }),
    /Invalid request/,
  );
  assert.throws(
    () =>
      validateIntegerTokenSchema(request, {
        type: "object",
        properties: {
          nested: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { type: "integer" } },
            },
          },
        },
      }),
    /Invalid request/,
  );
  assert.doesNotThrow(() =>
    validateIntegerTokenSchema(request, {
      type: "object",
      properties: {
        cost: { type: "number" },
        optional: { type: ["integer", "null"] },
      },
    }),
  );
});
test("canonical Value number kinds use the actual serde i64/u64 range rather than unlimited bigint", () => {
  const request = {} as FastifyRequest;
  parseRequestJson(
    request,
    '{"u64":18446744073709551615,"overflow":18446744073709551616,"negativeOverflow":-9223372036854775809}',
  );
  assert.equal(jsonNumberKind(request, ["u64"]), "integer");
  assert.equal(jsonNumberKind(request, ["overflow"]), "float");
  assert.equal(jsonNumberKind(request, ["negativeOverflow"]), "float");
});
test("real app parser preserves primitive f64 validation, rejects float integer tokens and exposes canonical generic fields", async () => {
  const { buildApp } = await import("../src/app.js"),
    { readConfig } = await import("../src/config.js");
  const app = await buildApp(
    {
      config: readConfig({
        DATABASE_URL: "postgres://unused",
        LOG_LEVEL: "silent",
      }),
      pool: {} as never,
    },
    [
      (app) => {
        app.post(
          "/synthetic/typed",
          {
            schema: {
              body: {
                type: "object",
                required: ["count", "amount"],
                properties: {
                  count: { type: "integer" },
                  amount: { type: "number" },
                },
              },
            },
          },
          async (request) => {
            const body = request.body as { count: number; amount: number };
            return {
              count: body.count,
              amount: new SerdeFloat(body.amount),
              canonical: canonicalJson(canonicalJsonBody(request)),
            };
          },
        );
      },
    ],
  );
  try {
    const rejected = await app.inject({
      method: "POST",
      url: "/synthetic/typed",
      headers: { "content-type": "application/json" },
      payload: '{"count":1.0,"amount":2.0}',
    });
    assert.equal(rejected.statusCode, 400);
    const large = await app.inject({
      method: "POST",
      url: "/synthetic/typed",
      headers: { "content-type": "application/json" },
      payload:
        '{"count":1,"amount":9223372036854775807,"metadata":{"float":1.0}}',
    });
    assert.equal(large.statusCode, 200);
    assert.equal(large.json().amount, Number(9223372036854775807n));
    assert.match(large.json().canonical, /"float":1.0/);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/synthetic/typed",
          headers: { "content-type": "application/json" },
          payload: '{"count":1,"amount":2,"__proto__":{}}',
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});
test("negative zero integer token is a float in actual serde parser and keeps its sign", () => {
  const request = {} as FastifyRequest;
  parseRequestJson(request, '{"negativeZero":-0}');
  assert.equal(jsonNumberKind(request, ["negativeZero"]), "float");
  assert.equal(
    canonicalJson(canonicalJsonBody(request)),
    '{"negativeZero":-0.0}',
  );
});
test("source-derived DTO map enforces manual i64/i32 and nested media fields while accepting f64 integer tokens", async () => {
  const { buildApp } = await import("../src/app.js"),
    { readConfig } = await import("../src/config.js");
  const app = await buildApp(
    {
      config: readConfig({
        DATABASE_URL: "postgres://unused",
        LOG_LEVEL: "silent",
      }),
      pool: {} as never,
    },
    [
      (app) => {
        app.post("/api/social/posts", async () => ({ ok: true }));
        app.post("/api/admin/leads", async (request) => ({
          quoteAmount: new SerdeFloat(
            (request.body as { quoteAmount: number }).quoteAmount,
          ),
        }));
      },
    ],
  );
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/social/posts",
          headers: { "content-type": "application/json" },
          payload: '{"media":[{"sortOrder":1.0}]}',
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/social/posts",
          headers: { "content-type": "application/json" },
          payload: '{"media":[{"sortOrder":2147483648}]}',
        })
      ).statusCode,
      400,
    );
    const float = await app.inject({
      method: "POST",
      url: "/api/admin/leads",
      headers: { "content-type": "application/json" },
      payload: '{"quoteAmount":9223372036854775807}',
    });
    assert.equal(float.statusCode, 200);
    assert.equal(float.json().quoteAmount, Number(9223372036854775807n));
  } finally {
    await app.close();
  }
});
test("actual generic Value invoice boundary and PostgreSQL JSONB retain floats for source integer fallbacks", async () => {
  const { buildApp } = await import("../src/app.js"),
    { readConfig } = await import("../src/config.js"),
    { invoiceInteger } = await import("../src/services/admin/invoices.js"),
    { installPgTimestampParsers } = await import("../src/db.js"),
    { default: pg } = await import("pg");
  installPgTimestampParsers();
  const decoder = pg.types.getTypeParser(3802, "text");
  const stored = decoder('{"integer":1,"float":1.0,"exponent":1e0}') as Record<
    string,
    unknown
  >;
  assert.equal(invoiceInteger(stored.integer, 14), 1);
  assert.equal(invoiceInteger(stored.float, 14), 14);
  assert.equal(invoiceInteger(stored.exponent, 14), 14);
  assert.equal(
    canonicalJson(stored),
    ' {"exponent":1.0,"float":1.0,"integer":1}'.trim(),
  );
  const app = await buildApp(
    {
      config: readConfig({
        DATABASE_URL: "postgres://unused",
        LOG_LEVEL: "silent",
      }),
      pool: {} as never,
    },
    [
      (app) => {
        app.post("/api/admin/invoices", async (request) => ({
          days: invoiceInteger(
            (request.body as Record<string, unknown>).validityDays,
            14,
          ),
        }));
      },
    ],
  );
  try {
    const result = await app.inject({
      method: "POST",
      url: "/api/admin/invoices",
      headers: { "content-type": "application/json" },
      payload: '{"validityDays":1.0}',
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().days, 14);
  } finally {
    await app.close();
  }
});
