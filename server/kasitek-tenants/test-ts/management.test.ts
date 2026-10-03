import test from "node:test";
import assert from "node:assert/strict";
import { analyticsFixture } from "./analytics-fixture.js";
import { buildApp } from "../src-ts/app.js";
import { readConfig } from "../src-ts/config.js";
import { tokenHash } from "../src-ts/middleware.js";
import { registerAdminRoutes } from "../src-ts/controllers/admin.js";
import {
  registerWorkspaceRoutes,
  verifyDomain,
} from "../src-ts/controllers/workspace.js";
import { registerClientsRoutes } from "../src-ts/controllers/clients.js";
import { registerLeadsRoutes } from "../src-ts/controllers/leads.js";
import { registerEmailSettingsRoutes } from "../src-ts/controllers/email-settings.js";
const url = process.env.TENANT_TEST_DATABASE_URL;
test(
  "management routes preserve permissions, domain/staff guards, tenant scope, and transactional lifecycle/outbox rollback",
  { skip: !url },
  async () => {
    const f = await analyticsFixture();
    const context = {
      pool: f.pool,
      config: readConfig({
        TENANT_DATABASE_URL: url,
        TENANT_PLATFORM_BASE_DOMAIN: "agency.example",
        TENANT_ADMIN_SECRET: "fixture-admin",
        LOG_LEVEL: "silent",
      }),
    };
    const app = await buildApp(context, [
      registerAdminRoutes,
      registerWorkspaceRoutes,
      registerClientsRoutes,
      registerLeadsRoutes,
      registerEmailSettingsRoutes,
    ]);
    const headers = {
      host: "workspace.agency.example",
      cookie: `${context.config.session_cookie_name}=fixture-session`,
    };
    const call = (
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
      path: string,
      payload?: unknown,
      extra: Record<string, string> = {},
    ) =>
      app.inject({
        method,
        url: path,
        headers: { ...headers, ...extra },
        ...(payload === undefined ? {} : { payload }),
      });
    const ok = async (
      method: Parameters<typeof call>[0],
      path: string,
      payload?: unknown,
      extra?: Record<string, string>,
    ) => {
      const res = await call(method, path, payload, extra);
      assert.ok(
        res.statusCode >= 200 && res.statusCode < 300,
        `${res.statusCode}: ${res.body}`,
      );
      return res.json();
    };
    try {
      await f.pool.query(
        `INSERT INTO workspace_branding(workspace_id,display_name) VALUES('w','Workspace');INSERT INTO tenant_users(id,workspace_id,email,password_hash,status) VALUES('staff','w','staff@example.test','unused','active'),('other','foreign','other@example.test','unused','active');INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('staff','owner');`,
      );
      await f.pool.query(
        `INSERT INTO tenant_sessions(id,workspace_id,tenant_user_id,token_hash,expires_at) VALUES('session','w','staff',$1,NOW()+INTERVAL '1 hour')`,
        [tokenHash("fixture-session")],
      );
      assert.equal(
        (await call("GET", "/api/admin/workspaces")).statusCode,
        403,
      );
      assert.equal(
        (
          await call("POST", "/api/clients", {
            name: 42,
            adminEmail: "a@example.test",
          })
        ).statusCode,
        400,
      );
      const client = await ok("POST", "/api/clients", {
          name: " Client One ",
          adminEmail: " OWNER@EXAMPLE.TEST ",
          external_ref: " ref ",
        }),
        id = client.client.id;
      assert.equal(client.client.externalRef, " ref ");
      assert.equal(client.adminInvite.email, "owner@example.test");
      assert.equal(client.adminInvite.emailSent, false);
      const invite = (
        await f.pool.query(
          `SELECT u.status,r.role FROM tenant_client_users u JOIN tenant_client_user_roles r ON r.tenant_client_user_id=u.id WHERE u.tenant_client_id=$1`,
          [id],
        )
      ).rows[0];
      assert.deepEqual(invite, { status: "invited", role: "owner" });
      const assigned = await ok("POST", `/api/clients/${id}/assignments`, {
        tenantUserId: "staff",
        assignmentRole: "member",
      });
      assert.equal(assigned.action, "assigned");
      assert.equal(
        (
          await ok("POST", `/api/clients/${id}/assignments`, {
            tenantUserId: "staff",
            assignmentRole: "member",
          })
        ).changed,
        false,
      );
      assert.equal(
        (
          await call("POST", `/api/clients/${id}/assignments`, {
            tenantUserId: "other",
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await ok("POST", `/api/clients/${id}/assignments`, {
            tenantUserId: "staff",
            assignmentRole: "admin",
          })
        ).action,
        "role_changed",
      );
      assert.equal(
        (await ok("DELETE", `/api/clients/${id}/assignments/staff`)).changed,
        true,
      );
      assert.equal(
        (await ok("DELETE", `/api/clients/${id}/assignments/staff`)).changed,
        false,
      );
      const lead = (
        await ok("POST", "/api/leads", {
          tenantClientId: id,
          name: " Lead ",
          email: " LEAD@EXAMPLE.TEST ",
          source: "voice",
          phone: "1",
          company: "Company",
        })
      ).lead;
      assert.equal(lead.score, 100);
      const otherClient = (
        await ok("POST", "/api/clients", {
          name: "Client Two",
          adminEmail: "second-owner@example.test",
        })
      ).client;
      await ok("POST", "/api/leads", {
        tenantClientId: otherClient.id,
        name: "Other Client Lead",
        email: "other-lead@example.test",
        source: "manual",
      });
      await f.pool.query(
        `INSERT INTO tenant_client_users(id,workspace_id,tenant_client_id,email,status) VALUES('client-staff','w',$1,'client-staff@example.test','active')`,
        [id],
      );
      await f.pool.query(
        `INSERT INTO tenant_client_user_roles(tenant_client_user_id,role) VALUES('client-staff','member')`,
      );
      await f.pool.query(
        `INSERT INTO tenant_client_sessions(id,workspace_id,tenant_client_id,tenant_client_user_id,token_hash,expires_at) VALUES('client-session','w',$1,'client-staff',$2,NOW()+INTERVAL '1 hour')`,
        [id, tokenHash("fixture-client-session")],
      );
      const results = await Promise.all([
        ok("PATCH", `/api/leads/${lead.id}/status`, { status: "qualified" }),
        ok("PATCH", `/api/leads/${lead.id}/status`, { status: "qualified" }),
      ]);
      assert.deepEqual(results.map((x) => x.changed).sort(), [false, true]);
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*) FROM tenant_lead_status_history WHERE lead_id=$1`,
            [lead.id],
          )
        ).rows[0].count,
        "1",
      );
      const workspaceStats = (
        await call("GET", "/api/leads/stats")
      ).json().stats;
      assert.equal(workspaceStats.total, 2);
      assert.equal(workspaceStats.qualified, 1);
      assert.deepEqual(workspaceStats.byStatus, [
        { status: "new", count: 1 },
        { status: "qualified", count: 1 },
      ]);
      assert.equal(
        workspaceStats.weeklyTrend.reduce(
          (sum: number, day: { count: number }) => sum + day.count,
          0,
        ),
        2,
      );
      const clientStatsResponse = await call(
        "GET",
        "/api/client/leads/stats",
        undefined,
        { cookie: "kasitenant.client.session=fixture-client-session" },
      );
      assert.equal(clientStatsResponse.statusCode, 200, clientStatsResponse.body);
      const clientStats = clientStatsResponse.json().stats;
      assert.equal(clientStats.total, 1);
      assert.equal(clientStats.qualified, 1);
      assert.equal(clientStats.byStatus.length, 1);
      assert.equal(clientStats.weeklyTrend, undefined);
      assert.equal(
        (
          await call("POST", "/api/leads", {
            tenantClientId: "foreign-client",
            name: "Denied",
            email: "a@example.test",
            source: "manual",
          })
        ).statusCode,
        400,
      );
      // Abort the analytics insert after the actual status/history statements. Their common SQL transaction must roll back all effects.
      const before = (
        await f.pool.query(`SELECT count(*) FROM analytics_outbox`)
      ).rows[0].count;
      await f.pool.query(
        `CREATE FUNCTION reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outbox failure'; END $$; CREATE TRIGGER reject_test_event BEFORE INSERT ON analytics_outbox FOR EACH ROW EXECUTE FUNCTION reject_test_event()`,
      );
      assert.equal(
        (
          await call("PATCH", `/api/leads/${lead.id}/status`, {
            status: "converted",
          })
        ).statusCode,
        500,
      );
      assert.equal(
        (
          await f.pool.query(`SELECT status FROM tenant_leads WHERE id=$1`, [
            lead.id,
          ])
        ).rows[0].status,
        "qualified",
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*) FROM tenant_lead_status_history WHERE lead_id=$1`,
            [lead.id],
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await call("PATCH", `/api/clients/${id}/status`, {
            status: "archived",
          })
        ).statusCode,
        500,
      );
      assert.equal(
        (
          await f.pool.query(`SELECT status FROM tenant_clients WHERE id=$1`, [
            id,
          ])
        ).rows[0].status,
        "active",
      );
      assert.equal(
        (
          await call("POST", `/api/clients/${id}/assignments`, {
            tenantUserId: "staff",
          })
        ).statusCode,
        500,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT status FROM tenant_client_assignments WHERE id=$1`,
            [assigned.assignmentId],
          )
        ).rows[0].status,
        "revoked",
      );
      assert.equal(
        (
          await call("POST", "/api/clients", {
            name: "Rollback Client",
            adminEmail: "a@example.test",
          })
        ).statusCode,
        500,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*) FROM tenant_clients WHERE slug='rollback-client'`,
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (
          await call(
            "POST",
            "/api/admin/workspaces",
            {
              workspaceName: "Rollback Workspace",
              slug: "rollback-workspace",
              adminEmail: "a@example.test",
            },
            { "x-admin-secret": "fixture-admin" },
          )
        ).statusCode,
        500,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT count(*) FROM workspaces WHERE slug='rollback-workspace'`,
          )
        ).rows[0].count,
        "0",
      );
      assert.equal(
        (await f.pool.query(`SELECT count(*) FROM analytics_outbox`)).rows[0]
          .count,
        before,
      );
      await f.pool.query(
        "DROP TRIGGER reject_test_event ON analytics_outbox;DROP FUNCTION reject_test_event()",
      );
      const created = await ok(
        "POST",
        "/api/admin/workspaces",
        {
          workspaceName: "New Workspace",
          slug: "new-workspace",
          adminEmail: "new@example.test",
        },
        { "x-admin-secret": "fixture-admin" },
      );
      assert.equal(created.adminInvite.emailSent, false);
      const first = (
        await ok("POST", "/api/workspace/domains", {
          domain: "https://portal.example.test/path",
        })
      ).domain;
      assert.equal(first.isPrimary, true);
      const second = (
        await ok("POST", "/api/workspace/domains", {
          domain: "second.example.test",
        })
      ).domain;
      await ok("POST", `/api/workspace/domains/${second.id}/primary`);
      assert.equal(
        (
          await f.pool.query(
            `SELECT custom_domain FROM workspace_branding WHERE workspace_id='w'`,
          )
        ).rows[0].custom_domain,
        "second.example.test",
      );
      await ok("DELETE", `/api/workspace/domains/${second.id}`);
      assert.equal(
        (
          await f.pool.query(
            `SELECT custom_domain FROM workspace_branding WHERE workspace_id='w'`,
          )
        ).rows[0].custom_domain,
        "portal.example.test",
      );
      const verified = await verifyDomain(
        {
          ...context,
          config: {
            ...context.config,
            portal_host_target: "target.example.test",
          },
        },
        "w",
        first.id,
        async () => new Set(["127.0.0.1"]),
      );
      assert.equal(verified.domain.dnsStatus, "verified");
      assert.equal(
        (await call("DELETE", "/api/workspace/staff/staff")).statusCode,
        400,
      );
      const email = await ok("PUT", "/api/workspace/email-sending", {
        sendingMode: "shared",
        senderName: "Fixture Sender",
        replyToEmail: " REPLY@EXAMPLE.TEST ",
        sharedSenderLocalPart: "support.team",
      });
      assert.equal(email.email.sender.senderName, "Fixture Sender");
      assert.equal(
        email.email.sender.fromEmail,
        "workspace-support-team@send.kasitek.co.za",
      );
      assert.equal(email.email.settings.replyToEmail, "reply@example.test");
      assert.equal(
        (
          await call("PUT", "/api/workspace/email-sending", {
            sendingMode: "custom",
            customDomainId: "foreign-domain",
          })
        ).statusCode,
        400,
      );
      await f.pool.query(
        `UPDATE tenant_user_roles SET role='viewer' WHERE tenant_user_id='staff'`,
      );
      assert.equal((await call("GET", "/api/workspace")).statusCode, 200);
      assert.equal((await call("GET", "/api/clients")).statusCode, 200);
      assert.equal(
        (
          await call("POST", "/api/clients", {
            name: "Denied",
            adminEmail: "a@example.test",
          })
        ).statusCode,
        403,
      );
      assert.equal((await call("GET", "/api/leads")).statusCode, 403);
      assert.equal(
        (await call("GET", "/api/workspace/email-sending")).statusCode,
        403,
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);
test(
  "email sending settings use source-shaped provider domains, verified sender selection, scoped denial and atomic verification fallback",
  { skip: !url },
  async () => {
    const f = await analyticsFixture(),
      context = {
        pool: f.pool,
        config: readConfig({
          TENANT_DATABASE_URL: url,
          TENANT_PLATFORM_BASE_DOMAIN: "agency.example",
          TENANT_RESEND_API_KEY: "synthetic-resend",
          LOG_LEVEL: "silent",
        }),
      };
    let status = "pending";
    const calls: { method: string; path: string; body: any }[] = [];
    const http: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname,
        method = init?.method ?? "GET";
      calls.push({
        method,
        path,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path === "/emails") return Response.json({ id: "fixture-message" });
      if (method === "DELETE" || path.endsWith("/verify"))
        return Response.json({ id: "fixture-domain" });
      return Response.json({
        data: {
          id: "fixture-domain",
          name: "mail.example.test",
          status,
          records: [
            {
              record: "DKIM",
              type: "TXT",
              name: "resend._domainkey",
              value: "fixture-key",
              status,
              ttl: "Auto",
              priority: null,
            },
          ],
        },
      });
    };
    const app = await buildApp(context, [
      (app, context) =>
        registerEmailSettingsRoutes(app, context, { fetch: http }),
    ]);
    const headers = {
      host: "workspace.agency.example",
      cookie: `${context.config.session_cookie_name}=fixture-session`,
    };
    const call = (
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      payload?: unknown,
    ) =>
      app.inject({
        method,
        url: path,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    const ok = async (
      method: Parameters<typeof call>[0],
      path: string,
      payload?: unknown,
    ) => {
      const r = await call(method, path, payload);
      assert.equal(r.statusCode, 200, r.body);
      return r.json();
    };
    try {
      await f.pool.query(
        `INSERT INTO tenant_users(id,workspace_id,email,password_hash,status) VALUES('staff','w','staff@example.test','unused','active');INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('staff','owner')`,
      );
      await f.pool.query(
        `INSERT INTO tenant_sessions(id,workspace_id,tenant_user_id,token_hash,expires_at) VALUES('session','w','staff',$1,NOW()+INTERVAL '1 hour')`,
        [tokenHash("fixture-session")],
      );
      const created = await ok("POST", "/api/workspace/email-sending/domains", {
          domain: "MAIL.EXAMPLE.TEST",
        }),
        domain = created.email.customDomains[0];
      assert.equal(domain.providerDomainId, "fixture-domain");
      assert.deepEqual(domain.records[0], {
        id: domain.records[0].id,
        recordGroup: "DKIM",
        recordType: "TXT",
        recordName: "resend._domainkey",
        recordValue: "fixture-key",
        recordStatus: "pending",
        ttl: "Auto",
        priority: null,
      });
      assert.equal(
        (
          await call("PUT", "/api/workspace/email-sending", {
            sendingMode: "custom",
            customDomainId: domain.id,
          })
        ).statusCode,
        400,
      );
      status = "verified";
      await ok(
        "POST",
        `/api/workspace/email-sending/domains/${domain.id}/verify`,
      );
      const custom = await ok("PUT", "/api/workspace/email-sending", {
        sendingMode: "custom",
        customDomainId: domain.id,
        senderName: "Custom Sender",
        sharedSenderLocalPart: "support",
      });
      assert.equal(custom.email.sender.fromEmail, "support@mail.example.test");
      assert.equal(custom.email.sender.sendingMode, "custom");
      const sent = await ok("POST", "/api/workspace/email-sending/test", {
        to: " RECIPIENT@EXAMPLE.TEST ",
      });
      assert.equal(sent.to, "recipient@example.test");
      assert.equal(sent.sender.fromEmail, "support@mail.example.test");
      const message = calls.find((c) => c.path === "/emails")!;
      assert.deepEqual(message.body.to, ["recipient@example.test"]);
      assert.equal(
        message.body.subject,
        "KasiTek email sending test for Workspace",
      );
      assert.match(
        message.body.text,
        /Custom Sender <support@mail.example.test>/,
      );
      const providerCount = calls.length;
      assert.equal(
        (
          await call(
            "POST",
            "/api/workspace/email-sending/domains/foreign/verify",
          )
        ).statusCode,
        404,
      );
      assert.equal(calls.length, providerCount);
      // Force the second statement of verification to fail, proving provider-record persistence and sending-mode fallback share one transaction.
      await f.pool.query(
        `CREATE FUNCTION reject_email_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic settings failure'; END $$;CREATE TRIGGER reject_email_settings BEFORE UPDATE ON workspace_email_settings FOR EACH ROW EXECUTE FUNCTION reject_email_settings()`,
      );
      status = "pending";
      assert.equal(
        (
          await call(
            "POST",
            `/api/workspace/email-sending/domains/${domain.id}/verify`,
          )
        ).statusCode,
        500,
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT status FROM workspace_email_domains WHERE id=$1`,
            [domain.id],
          )
        ).rows[0].status,
        "verified",
      );
      assert.equal(
        (
          await f.pool.query(
            `SELECT sending_mode FROM workspace_email_settings WHERE workspace_id='w'`,
          )
        ).rows[0].sending_mode,
        "custom",
      );
      await f.pool.query(
        "DROP TRIGGER reject_email_settings ON workspace_email_settings;DROP FUNCTION reject_email_settings()",
      );
      const fallback = await ok(
        "POST",
        `/api/workspace/email-sending/domains/${domain.id}/verify`,
      );
      assert.equal(fallback.email.settings.sendingMode, "shared");
      assert.equal(fallback.email.customDomains[0].status, "pending");
      await ok("DELETE", `/api/workspace/email-sending/domains/${domain.id}`);
      assert.equal(
        (
          await f.pool.query(
            `SELECT custom_domain_id FROM workspace_email_settings WHERE workspace_id='w'`,
          )
        ).rows[0].custom_domain_id,
        null,
      );
      assert.equal(calls.at(-1)!.method, "DELETE");
    } finally {
      await app.close();
      await f.close();
    }
  },
);
