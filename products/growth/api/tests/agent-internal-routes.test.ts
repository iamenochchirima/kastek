import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { readConfig } from "../src/config.js";
import {
  registerAgentInternalRoutes,
  type AgentInternalOptions,
} from "../src/routes/agent-internal.js";
import { installErrorHandler } from "../src/error.js";
import type { CoreContext } from "../src/context.js";
const options = {
  inbox: {},
  whatsapp: {
    updateConversation: async () => {
      throw new Error("unexpected effect");
    },
    markConversationRead: async () => {
      throw new Error("unexpected effect");
    },
    deliverAgentMessage: async () => {
      throw new Error("unexpected effect");
    },
  },
} as unknown as AgentInternalOptions;
const config = (environment = "development") =>
  readConfig({
    DATABASE_URL: "postgres://unused",
    ENVIRONMENT: environment,
    KASITEK_AGENTS_INTERNAL_TOKEN: "synthetic-internal-token",
    AGENTS_API_URL: "https://agents.synthetic.example",
    AGENTS_INTERNAL_AUTH_SECRET: "synthetic",
  });
const auth = {
  authorization: "Bearer synthetic-internal-token",
  "x-organization-id": "synthetic-org",
};
test("private Agents bridge covers every source registered route except the separately owned workspace report", async () => {
  const app = Fastify(),
    actual: string[] = [];
  app.addHook("onRoute", (route) => {
    for (const method of Array.isArray(route.method)
      ? route.method
      : [route.method])
      if (method !== "HEAD") actual.push(`${method} ${route.url}`);
  });
  registerAgentInternalRoutes(
    app,
    { config: config(), pool: {} } as CoreContext,
    options,
  );
  await app.ready();
  const rows = JSON.parse(
    readFileSync("../../../docs/programs/typescript-migration/ROUTES.json", "utf8"),
  ).rows as { owner: string; handler: string; method: string; path: string }[];
  const expected = rows
    .filter(
      (row) =>
        row.owner === "growth" &&
        row.handler.startsWith("agent_internal::") &&
        row.handler !== "agent_internal::get_workspace_report",
    )
    .map((row) => `${row.method} ${row.path.replace(/\{(\w+)\}/g, ":$1")}`);
  assert.equal(actual.length, 45);
  assert.deepEqual(actual.sort(), expected.sort());
  await app.close();
});
test("private Agents typed query extraction follows the Rust fields before delegated auth", async () => {
  const app = Fastify();
  installErrorHandler(app);
  registerAgentInternalRoutes(
    app,
    { config: config(), pool: {} } as CoreContext,
    options,
  );
  for (const [url, detail] of [
    [
      "/api/internal/agents/v1/connections?limit=65536",
      "number too large to fit in target type",
    ],
    [
      "/api/internal/agents/v1/bookings?limit=-1",
      "invalid digit found in string",
    ],
    [
      "/api/internal/agents/v1/templates?limit=9223372036854775808",
      "number too large to fit in target type",
    ],
    [
      "/api/internal/agents/v1/contacts?cursor=-1",
      "invalid digit found in string",
    ],
    [
      "/api/internal/agents/v1/content/posts/insights?publishedFrom=2026-01-01&published_from=2026-01-02",
      "duplicate field `publishedFrom`",
    ],
    [
      "/api/internal/agents/v1/credits/usage?sourceType=one&source_type=two",
      "duplicate field `sourceType`",
    ],
  ] as const) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(response.body, `Query deserialize error: ${detail}`);
  }
  for (const url of [
    "/api/internal/agents/v1/connections?limit=0",
    "/api/internal/agents/v1/connections?unknown=one&unknown=two",
    "/api/internal/agents/v1/contacts?cursor=18446744073709551615",
  ]) {
    assert.equal((await app.inject({ url })).statusCode, 401);
  }
  await app.close();
});
test("private Agents bridge preserves scoped workspace queries, rejects missing credentials and prevents unsupported writes", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const app = Fastify();
  installErrorHandler(app);
  registerAgentInternalRoutes(
    app,
    {
      config: config(),
      pool: {
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          return {
            rows: [{ provider: "GOOGLE", status: "CONNECTED", count: "2" }],
          };
        },
      },
    } as unknown as CoreContext,
    options,
  );
  assert.equal(
    (await app.inject("/api/internal/agents/v1/workspace/status")).statusCode,
    401,
  );
  const result = await app.inject({
    url: "/api/internal/agents/v1/workspace/status",
    headers: auth,
  });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls[0]?.values, ["synthetic-org"]);
  assert.deepEqual(result.json().connections, [
    { provider: "GOOGLE", status: "CONNECTED", count: 2 },
  ]);
  const rejected = await app.inject({
    method: "PATCH",
    url: "/api/internal/agents/v1/connections/synthetic/status",
    headers: auth,
    payload: { status: "CONNECTED" },
  });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.json().error, /DISCONNECTED or REVOKED/);
  assert.equal(calls.length, 1);
  const draft = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/content/posts",
    headers: auth,
    payload: { content: "synthetic" },
  });
  assert.equal(draft.statusCode, 400);
  assert.match(draft.json().error, /idempotency-key is required/);
  const rejectedDelivery = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/channels/deliver",
    headers: { ...auth, "idempotency-key": "synthetic-key" },
    payload: {
      channelType: "facebook",
      externalConversationId: "synthetic",
      text: "text",
      media: [{ assetId: "synthetic", kind: "image" }],
    },
  });
  assert.equal(rejectedDelivery.statusCode, 400);
  assert.match(rejectedDelivery.json().error, /support text only/);
  await app.close();
});
test("private email projection omits external account identity and scopes, while production rejects development bearer", async () => {
  const app = Fastify();
  installErrorHandler(app);
  registerAgentInternalRoutes(
    app,
    {
      config: config(),
      pool: {
        query: async () => ({
          rows: [
            {
              id: "synthetic-mailbox",
              provider: "GOOGLE",
              email_address: "synthetic@example.invalid",
              display_name: "Synthetic",
              external_account_id: "provider-private-id",
              scopes: ["private-scope"],
            },
          ],
        }),
      },
    } as unknown as CoreContext,
    options,
  );
  const response = await app.inject({
    url: "/api/internal/agents/v1/email/connections/synthetic-mailbox",
    headers: auth,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().connection.externalAccountId, undefined);
  assert.equal(response.json().connection.scopes, undefined);
  await app.close();
  const prod = Fastify();
  installErrorHandler(prod);
  registerAgentInternalRoutes(
    prod,
    {
      config: config("production"),
      pool: {
        query: async () => {
          throw new Error("unexpected database");
        },
      },
    } as unknown as CoreContext,
    options,
  );
  assert.equal(
    (
      await prod.inject({
        url: "/api/internal/agents/v1/workspace/status",
        headers: auth,
      })
    ).statusCode,
    401,
  );
  await prod.close();
});
test("raw media authenticates before buffering or parsing a payload and malformed delivery DTOs fail without effects", async () => {
  const app = Fastify();
  installErrorHandler(app);
  registerAgentInternalRoutes(
    app,
    {
      config: config(),
      pool: {
        query: async () => {
          throw new Error("unexpected database");
        },
      },
    } as unknown as CoreContext,
    options,
  );
  const unauth = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/content/media",
    headers: { "content-type": "application/x-synthetic" },
    payload: Buffer.from("synthetic"),
  });
  assert.equal(unauth.statusCode, 401);
  const invalid = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/channels/deliver",
    headers: { ...auth, "idempotency-key": "synthetic" },
    payload: {
      channelType: "whatsapp",
      externalConversationId: "synthetic",
      text: "hello",
      media: [{ assetId: 4, kind: "image" }],
    },
  });
  assert.equal(invalid.statusCode, 400);
  const invalidButtons = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/channels/deliver",
    headers: { ...auth, "idempotency-key": "synthetic" },
    payload: {
      channelType: "whatsapp",
      externalConversationId: "synthetic",
      text: "hello",
      buttons: [{ id: "valid", title: 4 }],
    },
  });
  assert.equal(invalidButtons.statusCode, 400);
  const nullText = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/channels/deliver",
    headers: { ...auth, "idempotency-key": "synthetic" },
    payload: {
      channelType: "whatsapp",
      externalConversationId: "synthetic",
      text: null,
    },
  });
  assert.equal(nullText.statusCode, 400);
  const nullScopes = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/email/connections",
    headers: auth,
    payload: {
      userId: "synthetic",
      provider: "GOOGLE",
      externalAccountId: "synthetic",
      emailAddress: "synthetic@example.invalid",
      displayName: "synthetic",
      accessToken: "synthetic",
      scopes: null,
    },
  });
  assert.equal(nullScopes.statusCode, 400);
  await app.close();
});
test("signed private HTTP delegation binds grants, idempotency and replay before credit database writes", async () => {
  const { generateKeyPair, exportSPKI, SignJWT } = await import("jose");
  const keys = await generateKeyPair("ES256"),
    publicKey = await exportSPKI(keys.publicKey),
    now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    organizationId: "signed-org",
    installationId: "installation",
    capability: "kasitek.core.credits_reserve",
    capabilityVersion: "1",
    runId: "run",
    invocationId: "invoke",
    correlationId: "trace",
    idempotencyKey: "signed-key",
  })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("kasitek-agents")
    .setAudience("kasitek-core-internal")
    .setSubject("installation")
    .setJti("one-use")
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(keys.privateKey);
  const app = Fastify();
  installErrorHandler(app);
  const used = new Set<string>();
  const config = readConfig({
    DATABASE_URL: "postgres://unused",
    AGENTS_DELEGATION_PUBLIC_KEY: publicKey,
  });
  registerAgentInternalRoutes(
    app,
    {
      config,
      pool: {
        query: async () => {
          throw new Error("unexpected database");
        },
      },
    } as unknown as CoreContext,
    {
      ...options,
      replay: async (_issuer, jti) => {
        if (used.has(jti)) return false;
        used.add(jti);
        return true;
      },
    },
  );
  const headers = {
    authorization: "Bearer " + token,
    "x-organization-id": "untrusted-org",
  };
  const conflict = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/credits/reservations",
    headers,
    payload: {
      actionKey: "synthetic",
      estimatedCredits: 1,
      idempotencyKey: "different-key",
    },
  });
  assert.equal(conflict.statusCode, 409);
  assert.match(conflict.json().error, /signed delegation/);
  const replayed = await app.inject({
    method: "POST",
    url: "/api/internal/agents/v1/credits/reservations",
    headers,
    payload: {
      actionKey: "synthetic",
      estimatedCredits: 1,
      idempotencyKey: "signed-key",
    },
  });
  assert.equal(replayed.statusCode, 401);
  await app.close();
});
