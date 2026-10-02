import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { readConfig } from "../src-ts/config.js";
import { buildApp } from "../src-ts/app.js";
import { registerSocialRoutes } from "../src-ts/routes/social.js";
import { registerAiRoutes } from "../src-ts/routes/ai.js";
import { sha256 } from "../src-ts/identity/session.js";

test("Social registration matches authoritative Rust route inventory including provider callback boundaries", async () => {
  const observed = new Set<string>();
  const pool = new pg.Pool({ connectionString: "postgres://unused" });
  const config = readConfig({ DATABASE_URL: "postgres://unused" });
  const app = await buildApp({ pool, config }, [
    (app, ctx) => {
      app.addHook("onRoute", (route) => {
        for (const method of Array.isArray(route.method)
          ? route.method
          : [route.method])
          if (method !== "HEAD") observed.add(`${method} ${route.url}`);
      });
      registerSocialRoutes(app, ctx);
      registerAiRoutes(app, ctx);
    },
  ]);
  try {
    await app.ready();
    const fixture = JSON.parse(
      readFileSync("../../../plans/typescript-migration/ROUTES.json", "utf8"),
    );
    const expected = new Set<string>(
      fixture.rows
        .filter(
          (row: { handler: string; owner: string }) =>
            row.owner === "growth" &&
            (row.handler.startsWith("social::") ||
              row.handler.startsWith("ai::")),
        )
        .map(
          (row: { method: string; path: string }) =>
            `${row.method} ${row.path.replace(/\{([^}]+)\}/g, ":$1")}`,
        ),
    );
    assert.ok(expected.size > 40);
    assert.deepEqual([...observed].sort(), [...expected].sort());
    const publicResponse = await app.inject(
      "/api/social/oauth/bluesky/client-metadata",
    );
    assert.notEqual(publicResponse.statusCode, 401);
    const privateResponse = await app.inject("/api/social/posts");
    assert.equal(privateResponse.statusCode, 401);
  } finally {
    await app.close();
    await pool.end();
  }
});

test(
  "isolated Social OAuth retains PKCE/state cookies and admin boundary, while TikTok verifies untouched bytes",
  { skip: !process.env.CORE_SOCIAL_TEST_DATABASE_URL },
  async () => {
    const schema = `social_route_test_${randomUUID().replaceAll("-", "")}`,
      admin = new pg.Pool({
        connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
      });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    const config = readConfig({
      DATABASE_URL: "postgres://unused",
      AUTH_X_CLIENT_ID: "synthetic-client",
      AUTH_TIKTOK_CLIENT_SECRET: "synthetic-secret",
      AUTH_TIKTOK_CLIENT_KEY: "synthetic-key",
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await pool.query(
        `CREATE TABLE "User"(id text,name text,email text,phone text,image text,"emailVerified" timestamp,"createdAt" timestamp,"updatedAt" timestamp);CREATE TABLE "Session"("userId" text,"refreshToken" text,"identityCheckedAt" timestamp,"providerRefreshedAt" timestamp,"sessionToken" text,expires timestamp,"lastActivityAt" timestamp);CREATE TABLE "Organization"(id text,"createdAt" timestamp);CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);CREATE TABLE "ExternalConnectionAuthorizationAttempt"(id text,"connectionId" text,provider text,"authMode" text,target text,state text,"requestedCapabilities" text[],"orgId" text,"userId" text,status text,"expiresAt" timestamp,"completedAt" timestamp,"failureCode" text,"updatedAt" timestamp);CREATE TABLE "SocialWebhookEvent"(id text PRIMARY KEY,provider text,"eventKey" text,"eventType" text,"externalAccountId" text,payload jsonb,status text,attempts integer,"nextAttemptAt" timestamp,"receivedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp,UNIQUE(provider,"eventKey"));INSERT INTO "User" VALUES('user','Synthetic','fixture@example.test',NULL,NULL,NOW(),NOW(),NOW());INSERT INTO "Organization" VALUES('org',NOW());INSERT INTO "OrganizationMember" VALUES('org','user','OWNER');`,
      );
      await pool.query(
        `INSERT INTO "Session" VALUES('user','unused',NOW(),NOW(),$1,NOW()+INTERVAL '1 day',NOW())`,
        [sha256("synthetic-session")],
      );
      app = await buildApp({ pool, config }, [registerSocialRoutes]);
      const headers = { cookie: "kasitek_session=synthetic-session" };
      const started = await app.inject({
        url: "/api/social/oauth/x/start",
        headers,
      });
      assert.equal(started.statusCode, 302);
      const location = new URL(started.headers.location!);
      assert.equal(location.searchParams.get("client_id"), "synthetic-client");
      assert.equal(location.searchParams.get("code_challenge_method"), "S256");
      assert.ok(
        started.cookies.some(
          (value) => value.name === "kasitek_social_x_verifier",
        ),
      );
      assert.ok(started.cookies.every((value) => value.httpOnly === true));
      assert.equal(
        (
          await app.inject({
            url: "/api/social/oauth/x/callback?code=fake&state=tampered",
            headers,
          })
        ).statusCode,
        400,
      );
      const denied = await app.inject({
        url: "/api/social/oauth/x/callback?error=denied&error_description=synthetic%20denied",
        headers,
      });
      assert.equal(denied.statusCode, 302);
      assert.equal(
        denied.headers.location,
        "http://localhost:3000/connections?error=synthetic%20denied",
      );
      await pool.query(`UPDATE "OrganizationMember" SET role='MEMBER'`);
      assert.equal(
        (await app.inject({ url: "/api/social/oauth/x/start", headers }))
          .statusCode,
        403,
      );
      const raw = Buffer.from(
          ' { "client_key": "synthetic-key", "event": "unknown" } ',
        ),
        timestamp = Math.floor(Date.now() / 1000),
        signature = createHmac("sha256", "synthetic-secret")
          .update(`${timestamp}.`)
          .update(raw)
          .digest("hex");
      const request = {
        method: "POST" as const,
        url: "/api/webhooks/tiktok",
        headers: {
          "content-type": "application/json",
          "tiktok-signature": `t=${timestamp},s=${signature}`,
        },
        payload: raw,
      };
      const accepted = await app.inject(request);
      assert.equal(accepted.statusCode, 200);
      assert.deepEqual(accepted.json(), { received: true, duplicate: false });
      assert.equal((await app.inject(request)).json().duplicate, true);
      assert.equal(
        (
          await app.inject({
            ...request,
            payload: Buffer.from(raw.toString().trim()),
          })
        ).statusCode,
        401,
      );
    } finally {
      await app?.close();
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
