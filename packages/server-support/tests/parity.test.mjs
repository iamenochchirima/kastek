import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createCipheriv, generateKeyPairSync } from "node:crypto";
import { jwtVerify, importSPKI } from "jose";
import { encryptWithAes256Gcm, decryptWithAes256Gcm } from "../dist/crypto.js";
import {
  canonicalJson,
  canonicalJsonSha256,
  parseCanonicalJson,
  parseLosslessJson,
  timestamp,
} from "../dist/json.js";
import {
  buildEvent,
  coreProducerConfig,
  backfillSourceSequence,
  buildObservation,
} from "../dist/analytics-producer.js";
import { ReportingGrantIssuer } from "../dist/analytics-reporting.js";
import {
  responseOutcomes,
  AnalyticsIngestionClient,
} from "../dist/publisher.js";
import { redactTelemetryText, initTelemetry } from "../dist/telemetry.js";
import { createServer } from "node:http";
test("configured publisher retries preserve whole-second Rust duration arithmetic", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const row = { source_sequence: 1, outbox_id: "retry-one", attempt_count: 3, record_id: "record-one" };
  const response = { acknowledgements: [{ source_sequence: 1, record_id: "record-one", status: "retryable" }] };
  const outcome = responseOutcomes([row], response, now,
    { base_delay_ms: 5999, max_delay_ms: 17999, jitter_window_ms: 999 })[0];
  assert.equal(outcome.kind, "retryable");
  assert.equal(outcome.retry_at.toISOString(), "2026-01-01T00:00:17.000Z");
  class PreciseDate extends Date { toISOString() { return "2026-01-01T00:00:00.123456Z"; } }
  assert.equal(timestamp(new PreciseDate(now)), "2026-01-01T00:00:00.123456Z");
});
test("AES format matches Rust nonce:tag:ciphertext and nonce:ciphertext+tag formats", () => {
  const nonce = Buffer.alloc(12, 7),
    key = createHash("sha256").update("fixture-secret").digest(),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
      cipher.update("hello 👋", "utf8"),
      cipher.final(),
    ]),
    tag = cipher.getAuthTag();
  assert.equal(
    decryptWithAes256Gcm(
      "fixture-secret",
      [nonce, tag, ciphertext].map((v) => v.toString("base64")).join(":"),
    ),
    "hello 👋",
  );
  assert.equal(
    decryptWithAes256Gcm(
      "fixture-secret",
      [nonce, Buffer.concat([ciphertext, tag])]
        .map((v) => v.toString("base64"))
        .join(":"),
    ),
    "hello 👋",
  );
  assert.equal(
    decryptWithAes256Gcm("secret", encryptWithAes256Gcm("secret", "value")),
    "value",
  );
  assert.throws(() =>
    decryptWithAes256Gcm(
      "wrong",
      [nonce, tag, ciphertext].map((v) => v.toString("base64")).join(":"),
    ),
  );
});
test("canonical fixtures retain serde integer and floating-point spellings", () => {
  for (const [source, expected] of [
    ["1.0", "1.0"],
    ["1e20", "1e+20"],
    ["1e21", "1e+21"],
    ["1e-7", "1e-7"],
    ["0.000001", "1e-6"],
    ["-0.0", "-0.0"],
    ["9007199254740993", "9007199254740993"],
  ])
    assert.equal(canonicalJson(parseCanonicalJson(source)), expected);
  assert.equal(
    canonicalJson({ b: 1, a: { z: 2, a: 3 } }),
    ' {"a":{"a":3,"z":2},"b":1}'.trim(),
  );
  assert.equal(
    parseLosslessJson('{"id":9007199254740993}').id,
    9007199254740993n,
  );
  assert.equal(
    canonicalJsonSha256({ count: 1 }),
    createHash("sha256").update('{"count":1}').digest("hex"),
  );
});
const event = {
  record_id: "event-1",
  source_domain: "campaigns",
  source_stream_key: "core:org-1",
  contract_name: "campaign.recipient_sent@1",
  schema_version: 1,
  scope_kind: "core_organization",
  scope_external_id: "org-1",
  subject_type: "recipient",
  subject_id: "recipient-1",
  occurred_at: "2023-11-14T22:13:20Z",
  attributes: { count: 1 },
};
test("producer event envelope and privacy rules match source", () => {
  const record = buildEvent(coreProducerConfig(), event);
  assert.equal(record.outbox_id, "core:event:event-1");
  assert.equal(record.envelope.time, event.occurred_at);
  assert.equal(record.envelope.subject, "recipient:recipient-1");
  assert.equal(
    record.envelope.dataschema,
    "https://kasitek.co.za/analytics/contracts/campaign.recipient_sent/1/v1.schema.json",
  );
  assert.equal(record.payload_hash, canonicalJsonSha256({ count: 1 }));
  assert.ok(!("correlation_id" in record.envelope));
  assert.throws(() =>
    buildEvent(coreProducerConfig(), {
      ...event,
      attributes: { nested: [{ TOKEN: "private" }] },
    }),
  );
  const expected =
    createHash("sha256")
      .update("kasitek.analytics.backfill:record-1")
      .digest()
      .readBigUInt64BE(0) & 0x7fffffffffffffffn || 1n;
  assert.equal(backfillSourceSequence("record-1"), expected);
});
test("reporting grant remains ES256, user scope bounded to 120 seconds", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pem = privateKey.export({ type: "sec1", format: "pem" }).toString();
  const issuer = await ReportingGrantIssuer.fromPem(
    pem,
    "kasitek-core",
    undefined,
    "key-1",
  );
  const token = await issuer.issue({
    principal_id: "user-1",
    scope_id: 4,
    root_scope_id: 1,
    descendant_mode: "none",
    permissions: ["query", "catalog", "query"],
    metric_keys: [],
    dimension_keys: [],
  });
  const { payload, protectedHeader } = await jwtVerify(
    token,
    await importSPKI(
      publicKey.export({ type: "spki", format: "pem" }).toString(),
      "ES256",
    ),
    { issuer: "kasitek-core", audience: "kasitek-analytics-reporting" },
  );
  assert.equal(protectedHeader.kid, "key-1");
  assert.equal(payload.exp - payload.iat, 120);
  assert.equal(payload.scope_id, 4);
  assert.deepEqual(payload.permissions, ["catalog", "query"]);
  assert.equal(payload.correlation_id, null);
  await assert.rejects(() =>
    issuer.issue({
      principal_id: "u",
      scope_id: 1,
      root_scope_id: 1,
      descendant_mode: "explicit",
      permissions: [],
      metric_keys: [],
      dimension_keys: [],
    }),
  );
});
test("acknowledgements match exact i64 sequences rather than JS-rounded numbers", () => {
  const rows = [
    {
      outbox_id: "o1",
      source_sequence: "9007199254740993",
      record_id: "r1",
      attempt_count: 1,
    },
  ];
  const response = {
    accepted_count: 1,
    duplicate_count: 0,
    rejected_count: 0,
    retryable_count: 0,
    acknowledgements: [
      {
        record_id: "r1",
        source_sequence: 9007199254740993n,
        status: "accepted",
      },
    ],
  };
  assert.deepEqual(responseOutcomes(rows, response, new Date()), [
    { kind: "accepted" },
  ]);
  assert.equal(
    responseOutcomes(rows, { ...response, acknowledgements: [] }, new Date())[0]
      .kind,
    "retryable",
  );
});
test("HTTP publisher auth and exact numeric source sequence survive transport", async () => {
  let requestBody;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer fixture");
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requestBody = body;
      res.setHeader("content-type", "application/json");
      res.end(
        '{"accepted_count":1,"duplicate_count":0,"rejected_count":0,"retryable_count":0,"acknowledgements":[{"record_id":"r1","source_sequence":9007199254740993,"status":"accepted"}]}',
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new AnalyticsIngestionClient(
      `http://127.0.0.1:${server.address().port}`,
      "fixture",
      2000,
    );
    const response = await client.sendBatch("core", [
      {
        ...buildEvent(coreProducerConfig(), event),
        record_id: "r1",
        source_sequence: "9007199254740993",
      },
    ]);
    assert.equal(
      response.acknowledgements[0].source_sequence,
      9007199254740993n,
    );
    assert.match(requestBody, /"source_sequence":9007199254740993/);
    assert.ok(!requestBody.includes("backfill_job_id"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test("redaction and disabled telemetry do not prevent application work", async () => {
  assert.equal(
    redactTelemetryText("Bearer abc ?code=secret token:xyz"),
    "Bearer [REDACTED] ?code=[REDACTED] token:[REDACTED]",
  );
  process.env.OTEL_SDK_DISABLED = "true";
  await initTelemetry("fixture").shutdown();
});
