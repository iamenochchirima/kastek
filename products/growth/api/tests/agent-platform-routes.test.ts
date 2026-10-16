import { Readable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { readConfig } from "../src/config.js";
import { registerAgentPlatformRoutes } from "../src/routes/agent-platform.js";
import { installErrorHandler } from "../src/error.js";
import {
  sanitizeMessageBody,
  validAudioSignature,
  guardRawPayload,
} from "../src/services/agent-platform/controller-support.js";
import type { CoreContext } from "../src/context.js";
test("all registered Rust Agent product routes are present with their exact methods and paths", async () => {
  const app = Fastify();
  const actual: string[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method)
      ? route.method
      : [route.method])
      if (method !== "HEAD") actual.push(`${method} ${route.url}`);
  });
  const core = {
    config: readConfig({ DATABASE_URL: "postgres://unused" }),
    pool: {
      query: () => {
        throw new Error("Unexpected database access");
      },
    },
  } as unknown as CoreContext;
  registerAgentPlatformRoutes(app, core);
  await app.ready();
  const fixture = JSON.parse(
    readFileSync("../../../docs/programs/typescript-migration/ROUTES.json", "utf8"),
  ).rows as { owner: string; handler: string; method: string; path: string }[];
  const expected = fixture
    .filter(
      (row) =>
        row.owner === "growth" && row.handler.startsWith("agent_platform::"),
    )
    .map((row) => `${row.method} ${row.path.replace(/\{(\w+)\}/g, ":$1")}`);
  assert.equal(actual.length, 153);
  assert.deepEqual(actual.sort(), expected.sort());
  await app.close();
});
test("platform message sanitization preserves source whitelist, model constraints and explicit conversation selection", () => {
  assert.deepEqual(
    sanitizeMessageBody({
      message: " hello ",
      idempotencyKey: " key-123456 ",
      createNew: true,
      resourceId: "forbidden",
      modelProvider: "openai",
      model: "gpt",
      context: { route: "/growth", secret: "no" },
    }),
    {
      message: "hello",
      idempotencyKey: "key-123456",
      createNew: true,
      modelProvider: "openai",
      model: "gpt",
      context: { route: "/growth" },
    },
  );
  assert.throws(
    () =>
      sanitizeMessageBody({ message: "hello", idempotencyKey: "key-123456" }),
    /Choose either/,
  );
  assert.throws(
    () =>
      sanitizeMessageBody({
        message: "hello",
        idempotencyKey: "key-123456",
        conversationId: "id",
        createNew: true,
      }),
    /Choose either/,
  );
  assert.throws(
    () =>
      sanitizeMessageBody({
        message: "hello",
        idempotencyKey: "key-123456",
        createNew: true,
        modelProvider: "openai",
      }),
    /changed together/,
  );
  assert.equal(
    validAudioSignature(Buffer.from("RIFF0000WAVE"), "audio/wav"),
    true,
  );
  assert.equal(
    validAudioSignature(Buffer.from("not audio"), "audio/wav"),
    false,
  );
});
test("OAuth callbacks remain anonymous, preserve raw query and redirect only source string fields", async () => {
  const app = Fastify();
  installErrorHandler(app);
  const config = readConfig({
    DATABASE_URL: "postgres://unused",
    FRONTEND_URL: "http://localhost:3000",
    AGENTS_API_URL: "https://agents.synthetic.example",
    AGENTS_INTERNAL_AUTH_SECRET: "synthetic",
  });
  let url = "";
  registerAgentPlatformRoutes(
    app,
    {
      config,
      pool: {
        query: () => {
          throw new Error("Unexpected database access");
        },
      },
    } as unknown as CoreContext,
    {
      fetch: async (input) => {
        url = String(input);
        return new Response(
          JSON.stringify({
            error: "denied",
            connection: "account",
            token: "secret",
            installationId: 4,
          }),
          { status: 400 },
        );
      },
    },
  );
  const response = await app.inject({
    method: "GET",
    url: "/api/agents/integrations/google/oauth/callback?state=a%2Fb&code=one+two",
  });
  assert.equal(response.statusCode, 302);
  assert.ok(url.endsWith("?state=a%2Fb&code=one+two"));
  assert.equal(
    response.headers.location,
    "http://localhost:3000/studio?connection=account&error=denied&status=error",
  );
  assert.equal(response.headers["cache-control"], "no-store");
  await app.close();
});

test("raw payload guard rejects incrementally before an oversized envelope is buffered", async () => {
  const bounded = guardRawPayload(
    Readable.from([Buffer.from("1234"), Buffer.from("5678")]),
    6,
    "synthetic exceeded",
  );
  await assert.rejects(async () => {
    for await (const _chunk of bounded) {
    }
  }, /synthetic exceeded/);
});
