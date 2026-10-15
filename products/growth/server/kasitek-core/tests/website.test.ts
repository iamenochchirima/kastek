import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";
import Fastify from "fastify";
import { installErrorHandler } from "../src/error.js";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import * as website from "../src/services/website/index.js";
import {
  WEBSITE_CHAT_FRAME,
  WEBSITE_CHAT_LOADER,
} from "../src/services/website/assets.js";
import {
  websiteChannelAudioPayload,
  websiteChannelMessagePayload,
} from "../src/services/website/payloads.js";
import { registerWebsiteRoutes } from "../src/routes/website.js";

test("Website normalization, channel payloads and widget assets preserve original contracts", () => {
  assert.equal(
    website.normalizeOrigin(" HTTPS://EXAMPLE.COM:443/// "),
    "https://example.com",
  );
  assert.throws(() => website.normalizeOrigin("https://example.com/path"));
  assert.throws(() => website.normalizeOrigin("https://example.com?"));
  assert.deepEqual(
    website.normalizeOrigins([
      "https://b.test",
      "https://a.test/",
      "https://b.test",
    ]),
    ["https://a.test", "https://b.test"],
  );
  assert.throws(() =>
    website.normalizeOrigins(
      Array.from({ length: 31 }, (_, i) => `https://${i}.test`),
    ),
  );
  assert.equal(
    website.normalizeAppearance({}, "violet").primaryColor,
    "#7c3aed",
  );
  assert.throws(() =>
    website.normalizeAppearance({ windowWidth: 299 }, "indigo"),
  );
  assert.throws(() =>
    website.normalizeWebsiteDeploymentInput({ displayName: "é".repeat(51) }),
  );
  assert.equal(
    websiteChannelMessagePayload(
      "wdg",
      "event",
      "visitor",
      "conversation",
      "hello",
    ).displayName,
    undefined,
  );
  const audio = websiteChannelAudioPayload(
    "wdg",
    "installation",
    "event",
    "visitor",
    "conversation",
    "",
    "asset",
    "audio/webm",
    "record.webm",
  );
  assert.deepEqual((audio.content as Record<string, unknown>).transcription, {
    status: "queued",
    provider: "elevenlabs",
  });
  const baseline = JSON.parse(
    readFileSync(
      new URL("./fixtures/response-contracts.json", import.meta.url),
      "utf8",
    ),
  ) as { websiteAssetSha256: Record<string, string> };
  for (const [name, value] of [
    ["WEBSITE_CHAT_LOADER", WEBSITE_CHAT_LOADER],
    ["WEBSITE_CHAT_FRAME", WEBSITE_CHAT_FRAME],
  ]) {
    assert.equal(
      createHash("sha256").update(value!).digest("hex"),
      baseline.websiteAssetSha256[name],
    );
  }
});

test(
  "Website deployment/session isolation, local Agent transport, binary audio and early-access submissions",
  { skip: !process.env.CORE_WEBSITE_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_WEBSITE_TEST_DATABASE_URL!,
      schema = `website_test_${randomUUID().replaceAll("-", "")}`,
      admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      max: 2,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    const calls: {
      path: string;
      body: any;
      actor: string;
      org: string;
      auth: string;
    }[] = [];
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({
        path: req.url!,
        body: body ? JSON.parse(body) : null,
        actor: String(req.headers["x-actor-id"]),
        org: String(req.headers["x-organization-id"]),
        auth: String(req.headers.authorization),
      });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url?.includes("transcription-jobs") &&
            !req.url?.endsWith("/retry")
            ? { id: "job", assetId: "audio-asset", status: "queued" }
            : { accepted: true },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const config = readConfig({
        DATABASE_URL: url,
        AGENTS_API_URL: `http://127.0.0.1:${address.port}`,
        AGENTS_INTERNAL_AUTH_SECRET: "synthetic-website-secret",
        KASITEK_CORE_PUBLIC_URL: "http://localhost:4900",
      }),
      core = { pool, config },
      emails: unknown[] = [],
      uploads: unknown[] = [];
    const app = Fastify();
    installErrorHandler(app);
    try {
      for (const name of [
        "AgentWebsiteDeployment",
        "AgentWebsiteVisitorSession",
        "AgentWebsiteDeliveryEvent",
        "QuoteRequest",
        "ProductWaitlistEntry",
        "ProductWaitlistEvent",
      ])
        await pool.query(
          `CREATE TABLE "${name}" (LIKE public."${name}" INCLUDING ALL)`,
        );
      await pool.query(
        `CREATE TABLE "Organization"(id text primary key,"ownerId" text);CREATE TABLE "ContentMediaAsset"(id text primary key,"orgId" text,metadata jsonb,"createdAt" timestamp DEFAULT NOW());CREATE TABLE "AdminUser"(id text primary key);INSERT INTO "Organization" VALUES('org','owner'),('foreign','other-owner')`,
      );
      const deployment = await website.createAgentWebsiteDeployment(
        pool,
        "org",
        "installation",
        "connection",
        "public",
        "owner",
        {
          allowedOrigins: ["https://customer.test"],
          appearance: { primaryColor: "#ABC" },
        },
      );
      assert.equal(deployment.appearance.primaryColor, "#abc");
      assert.equal(
        (
          await website.listAgentWebsiteDeployments(
            pool,
            "foreign",
            "installation",
          )
        ).length,
        0,
      );
      await assert.rejects(() =>
        website.updateAgentWebsiteDeployment(
          pool,
          "foreign",
          "installation",
          deployment.id,
          { displayName: "wrong" },
        ),
      );
      await assert.rejects(() =>
        website.publicAgentWebsiteDeployment(
          pool,
          "public",
          "https://foreign.test",
          false,
        ),
      );
      assert.equal(
        (
          await website.publicAgentWebsiteDeployment(
            pool,
            "public",
            "http://localhost:4900",
            true,
          )
        ).id,
        deployment.id,
      );
      const session = await website.createAgentWebsiteVisitorSession(
        pool,
        deployment,
        "https://customer.test/",
      );
      await assert.rejects(() =>
        website.activeAgentWebsiteVisitorSession(
          pool,
          session.publicSessionId,
          "https://foreign.test",
        ),
      );
      assert.equal(
        await website.recordAgentWebsiteDelivery(
          pool,
          "foreign",
          session.externalConversationId,
          "wrong",
          "no",
          [],
        ),
        null,
      );
      const event = await website.recordAgentWebsiteDelivery(
        pool,
        "org",
        session.externalConversationId,
        "event",
        "Hello",
        [],
        { version: "1", blocks: [] },
      );
      const repeated = await website.recordAgentWebsiteDelivery(
        pool,
        "org",
        session.externalConversationId,
        "event",
        "Changed",
        [],
      );
      assert.equal(event!.id, repeated!.id);
      assert.equal(repeated!.messageText, "Hello");
      assert.equal(
        (await website.listAgentWebsiteDeliveries(pool, session)).length,
        1,
      );
      assert.equal(
        (await website.listAgentWebsiteDeliveries(pool, session, event!.id))
          .length,
        0,
      );
      await registerWebsiteRoutes(app, core, {
        sendEmail: async (...args) => {
          emails.push(args.slice(1));
        },
        upload: async (_pool, _config, user, org, input) => {
          uploads.push({ user, org, ...input });
          return { id: "audio-asset" } as any;
        },
      });
      const headers = { origin: "https://customer.test" };
      assert.equal(
        (await app.inject({ url: "/api/widget/v1/loader.js" })).body,
        WEBSITE_CHAT_LOADER,
      );
      assert.equal(
        (await app.inject({ url: "/api/widget/v1/frame.html" })).body,
        WEBSITE_CHAT_FRAME,
      );
      assert.equal(
        (await app.inject({ url: "/api/widget/v1/deployments/public" }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/widget/v1/deployments/public",
            headers: { origin: "https://foreign.test" },
          })
        ).statusCode,
        404,
      );
      const bootstrap = await app.inject({
        url: "/api/widget/v1/deployments/public",
        headers,
      });
      assert.equal(
        bootstrap.headers["access-control-allow-origin"],
        "https://customer.test",
      );
      assert.equal(bootstrap.json().orgId, undefined);
      assert.equal(
        (await app.inject({ url: "/api/widget/v1/share/public" })).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "OPTIONS",
            url: `/api/widget/v1/sessions/${session.publicSessionId}/audio`,
            headers,
          })
        ).statusCode,
        204,
      );
      const base = `/api/widget/v1/sessions/${session.publicSessionId}`;
      const accepted = await app.inject({
        method: "POST",
        url: `${base}/messages`,
        headers,
        payload: {
          idempotencyKey: "message-key",
          text: " hello ",
          displayName: " Ada ",
        },
      });
      assert.equal(accepted.statusCode, 202, accepted.body);
      assert.equal(
        calls[0]!.actor,
        `website-session:${session.publicSessionId}`,
      );
      assert.equal(calls[0]!.org, "org");
      assert.match(calls[0]!.auth, /^Bearer /);
      assert.equal(calls[0]!.body.content.text, "hello");
      assert.equal(calls[0]!.body.displayName, "Ada");
      const bytes = Buffer.from([0, 255, 128, 2]);
      const audio = await app.inject({
        method: "POST",
        url: `${base}/audio`,
        headers: {
          ...headers,
          "content-type": "audio/webm; codecs=opus",
          "x-audio-idempotency-key": "audio-key",
          "x-audio-file-name": "record%20one.webm",
        },
        payload: bytes,
      });
      assert.equal(audio.statusCode, 202, audio.body);
      assert.deepEqual((uploads[0] as any).bytes, bytes);
      assert.equal((uploads[0] as any).fileName, "record one.webm");
      assert.equal(calls[1]!.actor, "owner");
      assert.equal(calls[1]!.body.content.assetId, "audio-asset");
      assert.equal(
        (await app.inject({ url: `${base}/audio/job`, headers })).statusCode,
        404,
      );
      await pool.query(
        `INSERT INTO "ContentMediaAsset"(id,"orgId",metadata) VALUES('audio-asset','org',$1)`,
        [
          {
            source: "website_widget",
            sourceKey: `website:public:${session.publicSessionId}:audio-key`,
          },
        ],
      );
      const status = await app.inject({ url: `${base}/audio/job`, headers });
      assert.equal(status.statusCode, 200, status.body);
      assert.match(status.json().audioUrl, /audio-asset/);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${base}/audio/job/retry`,
            headers,
          })
        ).statusCode,
        202,
      );
      assert.equal(
        (await app.inject({ url: `${base}/deliveries`, headers })).json()
          .deliveries[0].messageText,
        "Hello",
      );
      const waitlist = {
        contactPerson: "Ada",
        email: "ADA@example.test",
        products: ["kasitek_product_growth"],
        contactConsent: true,
      };
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/waitlist",
            payload: { ...waitlist, contactConsent: false },
          })
        ).statusCode,
        400,
      );
      const first = await app.inject({
        method: "POST",
        url: "/api/waitlist",
        payload: waitlist,
      });
      assert.equal(first.statusCode, 201, first.body);
      const second = await app.inject({
        method: "POST",
        url: "/api/waitlist",
        payload: waitlist,
      });
      assert.equal(second.json().id, first.json().id);
      assert.equal(emails.length, 1);
      assert.equal(
        (await pool.query(`SELECT count(*) FROM "ProductWaitlistEvent"`))
          .rows[0].count,
        "1",
      );
      const quote = await app.inject({
        method: "POST",
        url: "/api/quote-requests",
        payload: {
          businessName: "Business",
          contactPerson: "Ada",
          phone: "123",
          email: "ADA@example.test",
          businessType: "other",
          services: ["custom requested service"],
        },
      });
      assert.equal(quote.statusCode, 201, quote.body);
      assert.equal(emails.length, 2);
      await website.setAgentWebsiteDeploymentStatus(
        pool,
        "org",
        "installation",
        deployment.id,
        "PAUSED",
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/widget/v1/deployments/public",
            headers,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `${base}/messages`,
            headers,
            payload: { idempotencyKey: "second", text: "hello" },
          })
        ).statusCode,
        404,
      );
      await website.setAgentWebsiteDeploymentStatus(
        pool,
        "org",
        "installation",
        deployment.id,
        "REVOKED",
      );
      await assert.rejects(() =>
        website.setAgentWebsiteDeploymentStatus(
          pool,
          "org",
          "installation",
          deployment.id,
          "ACTIVE",
        ),
      );
      await pool.query(
        `UPDATE "AgentWebsiteVisitorSession" SET "expiresAt"=NOW()-INTERVAL '1 second' WHERE id=$1`,
        [session.id],
      );
      await assert.rejects(() =>
        website.activeAgentWebsiteVisitorSession(
          pool,
          session.publicSessionId,
          "https://customer.test",
        ),
      );
    } finally {
      await app.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
