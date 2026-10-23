import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyTiktokWebhookSignature,
  parseTiktokWebhookEnvelope,
} from "../src/services/social/webhooks.js";
import {
  matchesFileSignature,
  storagePath,
  safeFileName,
} from "../src/services/social/media.js";
import { verifyThreadsSignedRequest } from "../src/integrations/provider-auth.js";
import { readConfig } from "../src/config.js";
test("social webhooks verify raw bytes, timestamp freshness, client identity and signed Threads subject", () => {
  const body = Buffer.from(
    '{"client_key":"fixture-key","event":"post.publish.complete"}',
  );
  const env = {
    AUTH_TIKTOK_CLIENT_SECRET: "synthetic-secret",
    AUTH_TIKTOK_CLIENT_KEY: "fixture-key",
  };
  const signature = createHmac("sha256", env.AUTH_TIKTOK_CLIENT_SECRET)
    .update("1700000000.")
    .update(body)
    .digest("hex");
  verifyTiktokWebhookSignature(
    `t=1700000000,s=${signature}`,
    body,
    env,
    1700000060n,
  );
  assert.throws(
    () =>
      verifyTiktokWebhookSignature(
        `t=1700000000,s=${signature}`,
        Buffer.from("{}"),
        env,
        1700000060n,
      ),
    /Unauthorized/,
  );
  assert.throws(
    () =>
      verifyTiktokWebhookSignature(
        `t=1700000000,s=${signature}`,
        body,
        env,
        1700000400n,
      ),
    /Unauthorized/,
  );
  assert.equal(
    parseTiktokWebhookEnvelope(body, env).event,
    "post.publish.complete",
  );
  assert.throws(
    () =>
      parseTiktokWebhookEnvelope(body, {
        ...env,
        AUTH_TIKTOK_CLIENT_KEY: "wrong",
      }),
    /client key mismatch/,
  );
  const encoded = Buffer.from(
    '{"algorithm":"HMAC-SHA256","user_id":9223372036854775807}',
  ).toString("base64url");
  const signed =
    createHmac("sha256", "threads-secret").update(encoded).digest("base64url") +
    "." +
    encoded;
  assert.equal(
    verifyThreadsSignedRequest(
      readConfig({
        DATABASE_URL: "postgres://fixture",
        AUTH_THREADS_APP_SECRET: "threads-secret",
      }),
      signed,
    ),
    "9223372036854775807",
  );
  const config = readConfig({
    DATABASE_URL: "postgres://fixture",
    KASITEK_MEDIA_STORAGE_PATH: "/tmp/synthetic-media",
  });
  assert.throws(
    () => storagePath(config, "../outside"),
    /Invalid media storage key/,
  );
  assert.equal(safeFileName("../../my image.png"), "my_image.png");
  assert.equal(
    matchesFileSignature("audio/ogg", Buffer.from("OggS-synthetic")),
    true,
  );
  assert.equal(
    matchesFileSignature("audio/wav", Buffer.from("OggS-synthetic")),
    false,
  );
});
