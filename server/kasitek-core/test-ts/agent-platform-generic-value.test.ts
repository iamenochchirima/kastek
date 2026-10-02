import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { canonicalJson, SerdeFloat } from "@kasitek-labs/server-support/json";
import { verifyThreadsSignedRequest } from "../src-ts/integrations/provider-auth.js";
import { readConfig } from "../src-ts/config.js";
import { parseTiktokWebhookEnvelope } from "../src-ts/services/social/webhooks.js";
import { providerJson } from "../src-ts/services/social/provider-publishing.js";
import { createSocialPostIdempotent } from "../src-ts/services/social/posts.js";
import { obj } from "../src-ts/services/admin/common.js";
import type { Pool } from "pg";
const config = readConfig({
  DATABASE_URL: "postgres://unused",
  AUTH_THREADS_APP_SECRET: "synthetic-secret",
});
test("signed Threads numeric identifiers preserve the source Value number formatting", () => {
  for (const [token, expected] of [
    ["1.0", "1.0"],
    ["1e0", "1.0"],
    ["-0", "-0.0"],
    ["9223372036854775807", "9223372036854775807"],
    ["18446744073709551616", "1.8446744073709552e+19"],
  ]) {
    const payload = Buffer.from(
      `{"algorithm":"HMAC-SHA256","user_id":${token}}`,
    ).toString("base64url");
    const signature = createHmac("sha256", "synthetic-secret")
      .update(payload)
      .digest("base64url");
    assert.equal(
      verifyThreadsSignedRequest(config, `${signature}.${payload}`),
      expected,
    );
  }
});
test("TikTok webhook Value and social provider responses retain float kind and serde integer overflow", async () => {
  const body =
    '{"client_key":"fixture","event":"publish","value":1.0,"overflow":18446744073709551616}';
  const payload = parseTiktokWebhookEnvelope(Buffer.from(body), {
    AUTH_TIKTOK_CLIENT_KEY: "fixture",
  });
  assert.ok(payload.value instanceof SerdeFloat);
  assert.ok(payload.overflow instanceof SerdeFloat);
  const response = await providerJson(
    "https://fixture.invalid",
    {},
    "fixture",
    { fetch: async () => new Response(body) },
  );
  assert.equal(canonicalJson(response), canonicalJson(payload));
});
test("generic object consumers reject a boxed JSON floating number as metadata", async () => {
  assert.deepEqual(obj(new SerdeFloat(1)), {});
  const pool = {
    query: async (sql: string) => ({
      rows: sql.includes("SocialChannelConnection")
        ? [{ id: "synthetic-channel", platform: "X", status: "CONNECTED" }]
        : [],
    }),
  } as unknown as Pool;
  await assert.rejects(
    createSocialPostIdempotent(
      pool,
      "synthetic-user",
      "synthetic-org",
      {
        channels: ["X"],
        channelSelections: { X: "synthetic-channel" },
        content: "fixture",
        metadata: new SerdeFloat(1),
      },
      "synthetic-key",
    ),
    (error: any) =>
      error.status === 400 &&
      error.message === "Content metadata must be a JSON object",
  );
});

test("social numeric metric extraction rejects floating Value and permits an ordinary similarly named object key", async () => {
  const { numericValue } =
    await import("../src-ts/services/social/insights.js");
  assert.equal(numericValue(new SerdeFloat(1)), null);
  assert.equal(numericValue({ __serde_float: 1, other: 2 }), 3n);
  assert.equal(
    numericValue({ a: 9223372036854775807n, b: 1 }),
    9223372036854775807n,
  );
});
test("actual social insight projection serializes an integral percentage as Rust f64", async () => {
  const { getSocialPostInsights } =
    await import("../src-ts/services/social/insights.js");
  const { apiJson } = await import("../src-ts/json.js");
  const early = new Date("2030-01-01T00:00:00Z"),
    late = new Date("2030-01-02T00:00:00Z");
  const pool = {
    query: async (sql: string) => {
      let rows: unknown[] = [];
      if (sql.includes('FROM "SocialPost"'))
        rows = [
          {
            id: "post",
            title: "Fixture",
            content: "fixture",
            status: "PUBLISHED",
            published_at: late,
            primary_channel_id: null,
          },
        ];
      else if (sql.includes('FROM "SocialPublishJob"'))
        rows = [
          {
            id: "job",
            post_id: "post",
            platform: "X",
            status: "PUBLISHED",
            published_at: late,
          },
        ];
      else if (sql.includes('FROM "SocialPostInsightObservation"'))
        rows = [
          {
            publish_job_id: "job",
            metric_key: "likes",
            value: 2,
            availability: "available",
            observed_at: late,
            fetched_at: late,
          },
          {
            publish_job_id: "job",
            metric_key: "likes",
            value: 1,
            availability: "available",
            observed_at: early,
            fetched_at: early,
          },
        ];
      return { rows };
    },
  } as unknown as Pool;
  const result = await getSocialPostInsights(pool, "synthetic-org", "post", {});
  assert.ok(result);
  assert.match(apiJson(result), /"percentageChange":100\.0/);
});
test("typed OAuth expiry rejects decimal/exponent tokens while accepting an integer token", async () => {
  const { exchangeXCodeForTokens } =
    await import("../src-ts/integrations/provider-auth.js");
  const oauth = readConfig({
    DATABASE_URL: "postgres://unused",
    AUTH_X_CLIENT_ID: "fixture",
    AUTH_X_CLIENT_SECRET: "fixture",
    AUTH_X_REDIRECT_URI: "http://localhost/fixture",
  });
  for (const token of ["1.0", "1e0", "-0", "9223372036854775808"]) {
    await assert.rejects(
      exchangeXCodeForTokens(
        oauth,
        "code",
        "verifier",
        async () =>
          new Response(`{"access_token":"fixture","expires_in":${token}}`),
      ),
      (error: any) => error.message === "Failed to decode provider response",
    );
  }
  const result = await exchangeXCodeForTokens(
    oauth,
    "code",
    "verifier",
    async () => new Response('{"access_token":"fixture","expires_in":1}'),
  );
  assert.equal(result.expires_in, 1);
});

test("channel capability decoration keeps numeric metadata as a Value and public sanitizer leaves it numeric", async () => {
  const {
    mergeChannelMetadataWithCapabilities,
    sanitizePublicChannelMetadata,
  } = await import("../src-ts/services/social/channels.js");
  const floating = new SerdeFloat(1);
  const merged = mergeChannelMetadataWithCapabilities("X", floating);
  assert.equal(merged.value, floating);
  assert.equal(sanitizePublicChannelMetadata(floating), floating);
  assert.match(canonicalJson(merged), /"value":1\.0/);
  assert.throws(
    () =>
      parseTiktokWebhookEnvelope(
        Buffer.concat([
          Buffer.from('{"client_key":"fixture","event":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
        { AUTH_TIKTOK_CLIENT_KEY: "fixture" },
      ),
    (error: any) => error.status === 400,
  );
});
