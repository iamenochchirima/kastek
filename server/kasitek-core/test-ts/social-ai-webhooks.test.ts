import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import {
  generateSocialCaption,
  generateSocialIdeas,
} from "../src-ts/services/ai.js";
import {
  verifyTiktokWebhookSignature,
  parseTiktokWebhookEnvelope,
} from "../src-ts/services/social/webhooks.js";
import {
  matchesFileSignature,
  storagePath,
  safeFileName,
} from "../src-ts/services/social/media.js";
import { verifyThreadsSignedRequest } from "../src-ts/integrations/provider-auth.js";
import { readConfig } from "../src-ts/config.js";
test("social AI retains actual OpenRouter request contract and filters malformed output through a provider fixture", async () => {
  const pool = {
    query: async () => ({
      rows: [
        { businessName: "Synthetic", businessType: "SHOP", country: "ZA" },
      ],
    }),
  } as unknown as Pool;
  const requests: Record<string, unknown>[] = [];
  let output: unknown = {
    ideas: [
      {
        title: " title ",
        draft: " caption ",
        suggestedChannels: ["X", "UNKNOWN"],
      },
      { title: "", draft: "bad" },
    ],
  };
  const options = {
    env: { OPENROUTER_API_KEY: "synthetic-secret" },
    fetch: (async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      requests.push(JSON.parse(String(init!.body)));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(output) } }],
        }),
      );
    }) as typeof fetch,
  };
  assert.deepEqual(
    await generateSocialIdeas(
      pool,
      "user",
      { topic: " topic ", channels: [" x "] },
      options,
    ),
    {
      ideas: [
        {
          title: "title",
          draft: "caption",
          angle: "",
          hook: "",
          suggestedChannels: ["X"],
        },
      ],
    },
  );
  assert.equal(requests[0]!.model, "openai/gpt-4.1-mini");
  assert.equal(requests[0]!.temperature, 0.7);
  assert.equal(requests[0]!.max_tokens, 700);
  assert.ok(JSON.stringify(requests[0]).includes("Business context:"));
  output = {
    content: " caption ",
    variants: [
      { platform: "X", content: " short " },
      { platform: "UNKNOWN", content: "ignored" },
    ],
  };
  assert.deepEqual(
    await generateSocialCaption(
      pool,
      "user",
      { title: " Existing ", channels: ["x"] },
      options,
    ),
    {
      draft: {
        title: "Existing",
        content: "caption",
        suggestedChannels: ["X"],
        variants: [{ platform: "X", content: "short" }],
      },
    },
  );
  await assert.rejects(
    generateSocialIdeas(pool, "user", {}, options),
    /Add a topic or objective/,
  );
});
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
