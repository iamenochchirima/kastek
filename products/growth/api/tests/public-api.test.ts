import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import {
  beginRequest,
  finishRequest,
  createApiKey,
  rotateApiKey,
  revokeApiKey,
  listApiKeys,
  requestMetrics,
} from "../src/services/public-api.js";
import {
  supportedEventTypes,
  retryDelay,
  webhookSignature,
  stableEventId,
  validateDestinationUrl,
  createSubscription,
  listSubscriptions,
  enqueueDomainEvent,
  listDeliveries,
  processDueDeliveries,
} from "../src/services/public-webhooks.js";
import {
  pageWindow,
  paginateCollection,
  redactKeys,
} from "../src/routes/public-v1.js";
import { runBillingReconciliation } from "../src/workers/billing-reconciliation.js";
import { runPublicWebhooks } from "../src/workers/public-webhooks.js";
import type { RequestContext } from "../src/identity/request-context.js";
const principal: RequestContext = {
  principal: {
    kind: "workspace_api_key",
    id: "key",
    subjectUserId: "user",
    clientId: "key",
  },
  organizationId: "org",
  userId: "user",
  clientId: null,
  effectiveGrants: new Set(),
  apiScopes: new Set(["api:read"]),
  correlationId: "correlation",
  causationId: null,
  idempotencyKey: null,
};
test("public paging, redaction and signed event retry contracts", async () => {
  assert.deepEqual(pageWindow({ cursor: 1, limit: 2 }, 4), {
    cursor: 1,
    limit: 2,
    nextCursor: 3,
  });
  assert.throws(() => pageWindow({ limit: 0 }, 1));
  assert.throws(() => pageWindow({ cursor: 2 }, 1));
  assert.deepEqual(
    paginateCollection({ posts: [1, 2, 3] }, "posts", { limit: 2 }).pagination,
    { cursor: 0, limit: 2, nextCursor: 2, total: 3, version: "v1" },
  );
  assert.deepEqual(
    redactKeys({ data: [{ phone: "private", name: "Public" }] }, ["phone"]),
    { data: [{ name: "Public" }] },
  );
  assert.deepEqual(supportedEventTypes(), ["public_api.request.completed"]);
  assert.deepEqual(
    supportedEventTypes(["content.post.created", "content.post.created"]),
    ["content.post.created"],
  );
  assert.throws(() => supportedEventTypes(["secret.event"]));
  assert.equal(
    stableEventId("content.post.created", { postId: "post" }),
    "content.post.created:post",
  );
  assert.equal(retryDelay(1), 30);
  assert.equal(retryDelay(2), 60);
  assert.equal(retryDelay(10), 3600);
  assert.equal(
    webhookSignature("secret", 1700000000, Buffer.from("body")),
    `v1=${createHmac("sha256", "secret").update("1700000000.body").digest("hex")}`,
  );
  const config = readConfig({ DATABASE_URL: "postgres://unused" });
  await assert.rejects(validateDestinationUrl("http://127.0.0.1/hook", config));
  await assert.rejects(
    validateDestinationUrl("https://user:pass@example.test/hook", config),
  );
  await assert.rejects(
    validateDestinationUrl("https://127.0.0.1/hook", config),
  );
  await assert.rejects(
    validateDestinationUrl("http://localhost/hook", {
      ...config,
      environment: "production",
    }),
  );
});
test("native workers honor pre-aborted shutdown without queue effects", async () => {
  const controller = new AbortController();
  controller.abort();
  const pool = {
      async query() {
        throw new Error("Queue must not be touched");
      },
    } as unknown as pg.Pool,
    logger = { info() {}, error() {} };
  await runPublicWebhooks(
    pool,
    readConfig({ DATABASE_URL: "postgres://unused" }),
    controller.signal,
    logger,
  );
  await runBillingReconciliation(
    pool,
    readConfig({ DATABASE_URL: "postgres://unused" }),
    controller.signal,
    logger,
  );
});
test(
  "isolated PostgreSQL keys, distributed rate accounting and signed webhook delivery",
  { skip: !process.env.CORE_PUBLIC_API_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_PUBLIC_API_TEST_DATABASE_URL!,
      schema = `public_api_test_${randomUUID().replaceAll("-", "")}`,
      admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    let received = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks),
          time = Number(request.headers["x-kasitek-webhook-timestamp"]);
        assert.equal(
          request.headers["x-kasitek-webhook-signature"],
          webhookSignature("s".repeat(32), time, body),
        );
        received++;
        response.writeHead(204);
        response.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      for (const table of [
        "DeveloperApiKey",
        "PublicApiRequest",
        "UsageEvent",
        "PublicApiWebhookSubscription",
        "PublicApiWebhookDelivery",
      ])
        await pool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      // Prisma's @updatedAt does not guarantee a database default for raw SQL inserts.
      await pool.query('ALTER TABLE "PublicApiRequest" ALTER COLUMN "updatedAt" DROP DEFAULT');
      const key = await createApiKey(
        pool,
        "org",
        "user",
        "Synthetic key",
        null,
      );
      assert.match(key.secret, /^kst_[A-Za-z0-9_-]{43}$/);
      assert.equal((await listApiKeys(pool, "org")).length, 1);
      assert.equal("keyHash" in key.key, false);
      const rotated = await rotateApiKey(
        pool,
        "org",
        "user",
        String(key.key.id),
      );
      assert.notEqual(rotated.secret, key.secret);
      assert.equal(
        (await listApiKeys(pool, "org")).filter(
          (value) => value.status === "REVOKED",
        ).length,
        1,
      );
      await revokeApiKey(pool, "org", String(rotated.key.id));
      const scoped = await createApiKey(pool, "org", "user", "Publishing key", null, ["growth:read", "growth:publish"]);
      assert.deepEqual(scoped.key.scopes, ["growth:read", "growth:publish"]);
      const scopedRotation = await rotateApiKey(pool, "org", "user", String(scoped.key.id));
      assert.deepEqual(scopedRotation.key.scopes, scoped.key.scopes);
      await assert.rejects(createApiKey(pool, "org", "user", "Invalid authority", null, ["billing:manage"]), /valid API key permissions/);
      await assert.rejects(
        revokeApiKey(pool, "different", String(rotated.key.id)),
        /Active API key not found/,
      );
      const outcomes = await Promise.allSettled([
        beginRequest(pool, 1, principal, "GET", "/v1/contacts"),
        beginRequest(pool, 1, principal, "GET", "/v1/contacts"),
      ]);
      assert.equal(
        outcomes.filter((value) => value.status === "fulfilled").length,
        1,
      );
      const audit = (
        outcomes.find(
          (value) => value.status === "fulfilled",
        ) as PromiseFulfilledResult<Awaited<ReturnType<typeof beginRequest>>>
      ).value;
      await finishRequest(pool, audit, 200);
      assert.deepEqual((await requestMetrics(pool, principal)).requests, {
        total: 1,
        successful: 1,
        clientErrors: 0,
        serverErrors: 0,
        inFlight: 0,
      });
      const address = server.address() as { port: number },
        config = readConfig({
          DATABASE_URL: url,
          PUBLIC_WEBHOOK_ENCRYPTION_KEY: "synthetic-encryption",
        }),
        input = {
          url: `http://localhost:${address.port}/hook`,
          eventTypes: ["content.post.created"],
          secret: "s".repeat(32),
        },
        created = await createSubscription(
          pool,
          "org",
          input,
          config,
          "create",
        );
      const replay = await createSubscription(
        pool,
        "org",
        { url: "invalid URL" },
        config,
        "create",
      );
      assert.equal(replay.replayed, true);
      assert.equal(replay.secret, input.secret);
      assert.equal((await listSubscriptions(pool, "org")).length, 1);
      assert.equal("secretCiphertext" in created.subscription, false);
      await enqueueDomainEvent(pool, "org", "content.post.created", {
        postId: "post",
        title: "Synthetic",
      });
      await enqueueDomainEvent(pool, "org", "content.post.created", {
        postId: "post",
        title: "Synthetic",
      });
      assert.equal(
        (await listDeliveries(pool, "org", String(created.subscription.id)))
          .length,
        1,
      );
      assert.equal(await processDueDeliveries(pool, config, 10), 1);
      assert.equal(received, 1);
      assert.equal(
        (await listDeliveries(pool, "org", String(created.subscription.id)))[0]
          .status,
        "DELIVERED",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);

test("v1 HTTP contracts finalize denied requests and forward only authenticated organization scope", async () => {
  const { default: Fastify } = await import("fastify"),
    { default: cookie } = await import("@fastify/cookie"),
    { installErrorHandler } = await import("../src/error.js"),
    { registerPublicV1Routes } = await import("../src/routes/public-v1.js");
  const app = Fastify();
  await app.register(cookie);
  installErrorHandler(app);
  const finalized: number[] = [];
  let actionContext: RequestContext | undefined,
    draftInput: Record<string, unknown> | undefined;
  const query = async (sql: unknown, args: unknown[] = []) => {
    const text = typeof sql === "string" ? sql : (sql as { text: string }).text;
    if (text.startsWith('SELECT id,"orgId","createdById",scopes'))
      return {
        rows: [
          {
            id: "key",
            orgId: "trusted-org",
            createdById: "user",
            scopes: ["api:read"],
          },
        ],
        rowCount: 1,
      };
    if(text.startsWith('SELECT scopes FROM "DeveloperApiKey"'))return {rows:[{scopes:["api:read"]}],rowCount:1};
    if(text.includes('SELECT role::text FROM "OrganizationMember"'))return {rows:[{role:"OWNER"}],rowCount:1};
    if (text.startsWith("SELECT COUNT(") || (text.includes('FROM "PublicApiRequest"')&&text.includes("COUNT(*)")))
      return { rows: [{ count: "0" }], rowCount: 1 };
    if (text.includes('UPDATE "PublicApiRequest"'))
      finalized.push(Number(args[1]));
    return { rows: [], rowCount: 1 };
  };
  const pool = {
      query,
      async connect() {
        return { query, release() {} };
      },
    } as unknown as pg.Pool,
    config = readConfig({
      DATABASE_URL: "postgres://unused",
      PUBLIC_API_DEPRECATED_ROUTES: "/v1/contacts",
      PUBLIC_API_SUNSET: "Wed, 01 Jan 2031 00:00:00 GMT",
    });
  const definition = {
    name: "contacts.list",
    version: "1.0.0",
    lifecycle: "public",
    supportedRuntimes: ["direct"],
    supportedActors: ["api_client"],
    requiredGrants: [],
    risk: "read",
    owningDomain: "contacts",
    title: "Contacts",
    description: "List",
    inputSchema: {},
    outputSchema: {},
    approval: null,
    idempotency: null,
    requiredOAuthScopes: [],
    requiredEntitlements: [],
    dataClassification: null,
    audit: null,
    usage: null,
  };
  const adapter = {
    definitions() {
      return [
        definition,
        { ...definition, name: "content.posts.draft.create", risk: "write" },
      ];
    },
    async listContacts(context: RequestContext) {
      actionContext = context;
      return {
        contacts: [
          { phone: "private", metadata: { private: "value" }, name: "Visible" },
        ],
        stats: { filteredTotal: 1 },
      };
    },
    async createContentDraft(
      context: RequestContext,
      input: Record<string, unknown>,
    ) {
      actionContext = context;
      draftInput = input;
      return {};
    },
  } as unknown as import("../src/services/public-api.js").PublicDomainAdapter;
  registerPublicV1Routes(app, { pool, config }, adapter);
  await app.ready();
  try {
    const health = await app.inject("/v1/health");
    assert.equal(health.statusCode, 200);
    assert.equal(health.headers["x-api-version"], "v1");
    assert.ok(health.headers["x-correlation-id"]);
    const headers = {
      authorization: `Bearer kst_${"x".repeat(43)}`,
      "x-correlation-id": "test-correlation",
    };
    const contacts = await app.inject({ url: "/v1/contacts?limit=1", headers });
    assert.equal(contacts.statusCode, 200, contacts.body);
    assert.deepEqual(contacts.json().contacts, []);
    assert.equal(contacts.headers.deprecation, "true");
    assert.equal(contacts.headers["x-ratelimit-remaining"], "119");
    assert.equal(contacts.headers["x-correlation-id"], "test-correlation");
    assert.equal(actionContext, undefined, "Legacy adapters cannot bypass canonical operation policy");
    const forbidden = await app.inject({
      method: "POST",
      url: "/v1/content/posts",
      headers: { ...headers, "idempotency-key": "test-request" },
      payload: { organizationId: "attacker-org", content: "Draft" },
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(draftInput, undefined);
    assert.deepEqual(finalized, [200, 403]);
    const invalid = await app.inject({ url: "/v1/contacts?limit=0", headers });
    assert.equal(invalid.statusCode, 422);
    assert.equal(finalized.at(-1), 422);
    const openapi = await app.inject("/v1/openapi.json");
    assert.equal(openapi.statusCode, 200);
    assert.equal(openapi.json().openapi, "3.1.0");
  } finally {
    await app.close();
  }
});
