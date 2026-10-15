import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { jwtVerify } from "jose";
import { analyticsFixture } from "./analytics-fixture.js";
import { readConfig } from "../src/config.js";
import { apiJson } from "../src/json.js";
import { installErrorHandler } from "../src/error.js";
import { tokenHash } from "../src/middleware.js";
import { registerDashboardRoutes } from "../src/controllers/dashboard.js";
import { registerConversationsRoutes } from "../src/controllers/conversations.js";
import { registerAgentsRoutes } from "../src/controllers/agents.js";
import { registerUsageRoutes } from "../src/controllers/usage.js";
import { registerClientPortalRoutes } from "../src/controllers/client-portal.js";
import {
  registerAnalyticsRoutes,
  parseReportQuery,
} from "../src/controllers/analytics.js";
const enabled = !!process.env.TENANT_TEST_DATABASE_URL;
test("analytics timestamps accept Chrono separators and offsets while rejecting invalid dates", () => {
  const query = parseReportQuery({
    range_start: "2030-01-01 01:30:00.123456+0130",
    range_end: "2030-01-01T01:30:60.000001+0130",
    timezone: "UTC",
  });
  assert.equal(query.range_start, "2030-01-01T00:00:00.123456Z");
  assert.equal(query.range_end, "2030-01-01T00:00:60.000001Z");
  for (const range_start of [
    "2030-02-30T00:00:00Z",
    "2030-01-01T24:00:00Z",
    "2030-01-01T00:00:00+24:00",
  ])
    assert.throws(() =>
      parseReportQuery({
        range_start,
        range_end: "2030-01-02T00:00:00Z",
        timezone: "UTC",
      }),
    );
});
async function controllerFixture(extra: Record<string, string> = {}) {
  const db = await analyticsFixture();
  const config = readConfig({
    TENANT_DATABASE_URL: process.env.TENANT_TEST_DATABASE_URL!,
    TENANT_DEFAULT_WORKSPACE_SLUG: "workspace",
    ...extra,
  });
  try {
    await db.pool
      .query(`INSERT INTO tenant_users(id,workspace_id,email,password_hash,status) VALUES('owner','w','owner@example.test','fixture','active'),('viewer','w','viewer@example.test','fixture','active');INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('owner','owner'),('viewer','viewer');
 INSERT INTO tenant_client_users(id,workspace_id,tenant_client_id,email,status) VALUES('member','w','client','member@example.test','active');INSERT INTO tenant_client_user_roles(tenant_client_user_id,role) VALUES('member','member');
 INSERT INTO conversations(id,workspace_id,tenant_client_id,channel,customer_identifier,last_message_at) VALUES('own','w','client','website','own','2030-01-01T00:00:00.123456Z'),('other','w','client-other','website','other',NOW()),('foreign-conversation','foreign','foreign-client','website','foreign',NOW());
 INSERT INTO messages(id,conversation_id,workspace_id,sender_role,content,created_at) VALUES('own-message','own','w','customer','Own','2030-01-01T00:00:00.123456Z'),('other-message','other','w','customer','Other',NOW()),('foreign-message','foreign-conversation','foreign','customer','Foreign',NOW());
 INSERT INTO workspace_agents(id,workspace_id,name,status,config) VALUES('agent','w','Fixture','active','{"large":9007199254740993,"float":1.0}'),('foreign-agent','foreign','Foreign','active','{}');
 INSERT INTO workspace_usage_events(id,workspace_id,event_type,quantity) VALUES('usage','w','request',9007199254740993),('foreign-usage','foreign','request',99)`);
    for (const user of ["owner", "viewer"])
      await db.pool.query(
        `INSERT INTO tenant_sessions(id,workspace_id,tenant_user_id,token_hash,expires_at) VALUES($1,'w',$2,$3,NOW()+INTERVAL '1 hour')`,
        ["session-" + user, user, tokenHash("fixture-" + user)],
      );
    await db.pool.query(
      `INSERT INTO tenant_client_sessions(id,workspace_id,tenant_client_id,tenant_client_user_id,token_hash,expires_at) VALUES('client-session','w','client','member',$1,NOW()+INTERVAL '1 hour')`,
      [tokenHash("fixture-member")],
    );
    const app = Fastify();
    await app.register(cookie);
    installErrorHandler(app);
    app.setReplySerializer((payload) => apiJson(payload));
    const context = { pool: db.pool, config };
    for (const register of [
      registerDashboardRoutes,
      registerConversationsRoutes,
      registerAgentsRoutes,
      registerUsageRoutes,
      registerClientPortalRoutes,
      registerAnalyticsRoutes,
    ])
      register(app, context);
    await app.ready();
    return {
      app,
      context,
      pool: db.pool,
      owner: { cookie: "kasitenant.session=fixture-owner" },
      viewer: { cookie: "kasitenant.session=fixture-viewer" },
      member: { cookie: "kasitenant.client.session=fixture-member" },
      close: async () => {
        await app.close();
        await db.close();
      },
    };
  } catch (error) {
    await db.close();
    throw error;
  }
}
test(
  "Tenant read controllers retain exact keys, i64/JSON/date tokens and workspace/client/role isolation",
  { skip: !enabled },
  async () => {
    const f = await controllerFixture();
    try {
      for (const url of [
        "/api/dashboard/summary",
        "/api/conversations",
        "/api/agents",
        "/api/usage",
        "/api/client/overview",
      ])
        assert.equal((await f.app.inject({ url })).statusCode, 401);
      const summary = await f.app.inject({
        url: "/api/dashboard/summary",
        headers: f.owner,
      });
      assert.equal(summary.statusCode, 200);
      assert.match(summary.body, /"requestsThisMonth":9007199254740993/);
      assert.equal(summary.json().summary.totalClients, 2);
      const activity = await f.app.inject({
        url: "/api/dashboard/activity",
        headers: f.owner,
      });
      assert.equal(activity.statusCode, 200);
      assert(!activity.body.includes("Foreign"));
      const services = await f.app.inject({
        url: "/api/dashboard/services",
        headers: f.owner,
      });
      assert.deepEqual(
        services
          .json()
          .services.map((s: { id: string; is_active: boolean }) => [
            s.id,
            s.is_active,
          ]),
        [
          ["workspace", true],
          ["clients", true],
          ["agents", true],
          ["conversations", true],
          ["leads", false],
        ],
      );
      const agents = await f.app.inject({
        url: "/api/agents",
        headers: f.owner,
      });
      assert.match(agents.body, /"large":9007199254740993/);
      assert.match(agents.body, /"float":1\.0/);
      assert.equal(agents.json().agents.length, 1);
      assert.equal(
        (
          await f.app.inject({
            url: "/api/agents/foreign-agent",
            headers: f.owner,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await f.app.inject({ url: "/api/agents", headers: f.viewer }))
          .statusCode,
        403,
      );
      assert.equal(
        (await f.app.inject({ url: "/api/conversations", headers: f.viewer }))
          .statusCode,
        403,
      );
      const usage = await f.app.inject({
        url: "/api/usage",
        headers: f.viewer,
      });
      assert.match(usage.body, /"requestsThisMonth":9007199254740993/);
      assert.equal(usage.json().usage.limits.requestsPerMonth, 0);
      const conversations = await f.app.inject({
        url: "/api/conversations",
        headers: f.owner,
      });
      assert.equal(conversations.json().conversations.length, 2);
      const messages = await f.app.inject({
        url: "/api/conversations/own/messages",
        headers: f.owner,
      });
      assert.match(messages.body, /2030-01-01T00:00:00\.123456Z/);
      assert.equal(messages.json().messages.length, 1);
      assert.equal(
        (
          await f.app.inject({
            url: "/api/conversations/foreign-conversation/messages",
            headers: f.owner,
          })
        ).statusCode,
        404,
      );
      const overview = await f.app.inject({
        url: "/api/client/overview",
        headers: f.member,
      });
      assert.equal(overview.json().overview.totalConversations, 1);
      assert.equal(overview.json().overview.totalMessages, 1);
      assert.equal(
        (
          await f.app.inject({
            url: "/api/client/conversations",
            headers: f.member,
          })
        ).json().conversations.length,
        1,
      );
      assert.equal(
        (
          await f.app.inject({
            url: "/api/client/conversations/own",
            headers: f.member,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await f.app.inject({
            url: "/api/client/conversations/other/messages",
            headers: f.member,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await f.app.inject({
            url: "/api/client/conversations/own/messages",
            headers: f.member,
          })
        ).json().messages.length,
        1,
      );
      await f.pool.query(
        `INSERT INTO workspace_api_keys(id,workspace_id,label,key_prefix,key_hash,scopes) VALUES('fixture-key','w','Fixture','fixture',$1,'["tenant:portal"]')`,
        [tokenHash("fixture-api-key")],
      );
      assert.equal(
        (
          await f.app.inject({
            url: "/api/agents",
            headers: { authorization: "Bearer fixture-api-key" },
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await f.app.inject({
            url: "/api/dashboard/summary",
            headers: { authorization: "Bearer fixture-api-key" },
          })
        ).statusCode,
        401,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "Tenant reporting grants retain role-dependent descendants, forced scope, i64 identifiers and public redaction",
  { skip: !enabled },
  async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
        namedCurve: "prime256v1",
      }),
      grants: Record<string, unknown>[] = [];
    let requestBody: Record<string, unknown> | undefined,
      mismatch = false,
      upstream = 200;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://localhost");
      res.setHeader("content-type", "application/json");
      if (url.pathname.endsWith("/resolve")) {
        assert.equal(req.headers.authorization, "Bearer fixture-resolver");
        assert.equal(req.headers["x-source-service"], "tenant-platform");
        const scope = url.searchParams.get("scope_kind")!,
          external = url.searchParams.get("external_source_id")!;
        res.end(
          `{"scope_id":9007199254740993,"scope_kind":"${scope}","owning_source_service":"${mismatch ? "foreign" : "tenant-platform"}","external_source_id":"${external}","root_scope_id":9007199254740993,"reporting_timezone":"UTC"}`,
        );
        return;
      }
      const claims = (
        await jwtVerify(String(req.headers.authorization).slice(7), publicKey, {
          issuer: "kasitek-tenant-platform",
          audience: "kasitek-analytics-reporting",
        })
      ).payload;
      grants.push(claims);
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString();
        assert.match(raw, /"reporting_scope_id":9007199254740993/);
        requestBody = JSON.parse(raw);
      }
      res.statusCode = upstream;
      res.end('{"scope_id":9007199254740993,"metrics":[]}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address === "object");
    const f = await controllerFixture({
      ANALYTICS_REPORTING_URL: `http://127.0.0.1:${address.port}`,
      ANALYTICS_REPORTING_RESOLVER_TOKEN: "fixture-resolver",
      ANALYTICS_REPORTING_PRIVATE_KEY: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
    });
    try {
      const owner = await f.app.inject({
        url: "/api/analytics/catalog",
        headers: f.owner,
      });
      assert.equal(owner.statusCode, 200);
      assert.deepEqual(owner.json().scope, {
        kind: "tenant_workspace",
        externalId: "w",
      });
      assert(!owner.body.includes("scope_id"));
      assert.equal(grants.at(-1)!.descendant_mode, "all");
      assert.deepEqual(grants.at(-1)!.permissions, [
        "analytics:compare_children",
        "analytics:read",
      ]);
      assert.equal(
        Number(grants.at(-1)!.exp) - Number(grants.at(-1)!.iat),
        120,
      );
      assert.equal(
        (
          await f.app.inject({
            url: "/api/analytics/catalog",
            headers: f.viewer,
          })
        ).statusCode,
        200,
      );
      assert.equal(grants.at(-1)!.descendant_mode, "none");
      const body = {
        range_start: "2030-01-01T00:00:00.123456Z",
        range_end: "2030-01-02T00:00:00Z",
        timezone: "UTC",
        include_descendants: true,
      };
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/analytics/query",
            headers: f.viewer,
            payload: body,
          })
        ).statusCode,
        403,
      );
      const clientReport = await f.app.inject({
        method: "POST",
        url: "/api/client/analytics/query",
        headers: f.member,
        payload: { ...body, include_descendants: false },
      });
      assert.equal(clientReport.statusCode, 200, clientReport.body);
      assert.equal(grants.at(-1)!.sub, "member");
      assert.equal(grants.at(-1)!.descendant_mode, "none");
      assert.equal(requestBody!.include_descendants, false);
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/analytics/query",
            headers: f.owner,
            payload: body,
          })
        ).statusCode,
        200,
      );
      assert.equal(requestBody!.range_start, body.range_start);
      const client = await f.app.inject({
        url: "/api/client/analytics/catalog",
        headers: f.member,
      });
      assert.equal(client.statusCode, 200);
      assert.deepEqual(client.json().scope, {
        kind: "tenant_client",
        externalId: "client",
      });
      assert.equal(grants.at(-1)!.descendant_mode, "none");
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/client/analytics/query",
            headers: f.member,
            payload: body,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: "/api/analytics/query",
            headers: f.owner,
            payload: { ...body, reporting_scope_id: 99 },
          })
        ).statusCode,
        400,
      );
      mismatch = true;
      assert.equal(
        (
          await f.app.inject({
            url: "/api/analytics/catalog",
            headers: f.owner,
          })
        ).statusCode,
        500,
      );
      mismatch = false;
      upstream = 403;
      const denied = await f.app.inject({
        url: "/api/analytics/catalog",
        headers: f.owner,
      });
      assert.equal(denied.statusCode, 500);
      assert.match(denied.body, /authorization failed/);
      assert.throws(() => parseReportQuery({ ...body, metrics: null }));
    } finally {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
