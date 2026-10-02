import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  AnalyticsReportingClient,
  redactScopeId,
  withScope,
} from "../dist/analytics-reporting.js";
import {
  canonicalJson,
  parseSerdeValueJson,
  SerdeFloat,
} from "../dist/json.js";

async function fixture(t) {
  let body = "{}";
  const received = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    received.push({ path: request.url, text });
    response.setHeader("content-type", "application/json");
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    client: new AnalyticsReportingClient(
      `http://127.0.0.1:${server.address().port}`,
      "fixture-resolver",
    ),
    received,
    respond(value) {
      body = value;
    },
  };
}
const scope =
  '{"scope_id":9007199254740993,"root_scope_id":9223372036854775807,"scope_kind":"tenant_workspace","owning_source_service":"tenant-platform","external_source_id":"workspace-fixture","reporting_timezone":"UTC"}';

test("reporting scope uses typed i64 decoding and ignores unknown fields", async (t) => {
  const f = await fixture(t);
  f.respond(scope.replace("}", ',"extra_metric":1.25}'));
  assert.deepEqual(
    await f.client.resolveScope(
      "tenant-platform",
      "tenant_workspace",
      "workspace-fixture",
    ),
    {
      scope_id: 9007199254740993n,
      root_scope_id: 9223372036854775807n,
      scope_kind: "tenant_workspace",
      owning_source_service: "tenant-platform",
      external_source_id: "workspace-fixture",
      reporting_timezone: "UTC",
      parent_scope_id: null,
    },
  );
  for (const token of [
    "1.0",
    "1e0",
    "-0",
    "1.25",
    "9223372036854775808",
    '"1"',
    "null",
  ]) {
    for (const field of ["scope_id", "root_scope_id"]) {
      f.respond(
        scope.replace(new RegExp(`"${field}":\\d+`), `"${field}":${token}`),
      );
      await assert.rejects(
        f.client.resolveScope(
          "tenant-platform",
          "tenant_workspace",
          "workspace-fixture",
        ),
        SyntaxError,
      );
    }
    f.respond(scope.replace("}", `,"parent_scope_id":${token}}`));
    if (token === "null")
      assert.equal(
        (
          await f.client.resolveScope(
            "tenant-platform",
            "tenant_workspace",
            "workspace-fixture",
          )
        ).parent_scope_id,
        null,
      );
    else
      await assert.rejects(
        f.client.resolveScope(
          "tenant-platform",
          "tenant_workspace",
          "workspace-fixture",
        ),
        SyntaxError,
      );
  }
});

test("generic reporting values retain floats, numeric ranges and microsecond timestamps", async (t) => {
  const f = await fixture(t);
  const body =
    '{"scope_id":9007199254740993,"metric":1.0,"decimal":1.25,"exponent":1e0,"negative_zero":-0,"integer":18446744073709551615,"overflow":18446744073709551616,"timestamp":"2030-01-01T00:00:00.123456Z"}';
  f.respond(body);
  const result = await f.client.catalog("fixture-grant", 9007199254740993n);
  assert.equal(result.integer, 18446744073709551615n);
  for (const key of [
    "metric",
    "decimal",
    "exponent",
    "negative_zero",
    "overflow",
  ])
    assert.ok(result[key] instanceof SerdeFloat);
  assert.equal(canonicalJson(result.metric), "1.0");
  assert.equal(canonicalJson(result.decimal), "1.25");
  assert.equal(canonicalJson(result.exponent), "1.0");
  assert.equal(canonicalJson(result.negative_zero), "-0.0");
  assert.equal(canonicalJson(result.overflow), "1.8446744073709552e+19");
  assert.equal(result.timestamp, "2030-01-01T00:00:00.123456Z");
  const query = withScope(
    {
      range_start: result.timestamp,
      range_end: "2030-01-02T00:00:00.123456Z",
      timezone: "UTC",
      metrics: [],
      breakdowns: [],
      filters: {},
      include_descendants: false,
    },
    9007199254740993n,
  );
  assert.equal(
    canonicalJson(await f.client.report("fixture-grant", query)),
    canonicalJson(result),
  );
  assert.match(f.received.at(-1).text, /"reporting_scope_id":9007199254740993/);
  assert.match(f.received.at(-1).text, /2030-01-01T00:00:00.123456Z/);
  const redacted = redactScopeId(
    result,
    "tenant_workspace",
    "workspace-fixture",
  );
  assert.equal(redacted.scope_id, undefined);
  assert.equal(canonicalJson(redacted.metric), "1.0");
  f.respond("1.0");
  const primitive = await f.client.catalog("fixture-grant", 1);
  assert.equal(
    redactScopeId(primitive, "tenant_workspace", "workspace-fixture"),
    primitive,
  );
  assert.equal(canonicalJson(primitive), "1.0");
});

test("serde Value parser separates i64/u64 integers from out-of-range floating values", () => {
  for (const token of ["-9223372036854775808", "18446744073709551615"])
    assert.equal(canonicalJson(parseSerdeValueJson(token)), token);
  for (const token of [
    "-9223372036854775809",
    "18446744073709551616",
    "1.0",
    "-0",
  ])
    assert.ok(parseSerdeValueJson(token) instanceof SerdeFloat);
  assert.throws(() => parseSerdeValueJson("1e999"), /finite/);
});
