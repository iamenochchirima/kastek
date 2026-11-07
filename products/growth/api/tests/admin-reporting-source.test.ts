import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { buildApp } from "../src/app.js";
import { registerAdminAnalyticsRoutes } from "../src/routes/admin-analytics.js";
import { growthAdminReport } from "../src/services/admin/reporting-source.js";
import { registerAdminReportingRoutes } from "../src/routes/admin-reporting.js";
import { createAdminSession } from "../src/identity/admin-session.js";
import { readConfig } from "../src/config.js";
import { parseAdminReportQuery } from "@kasitek-labs/server-support/admin-reporting";

const url = process.env.ADMIN_REPORTING_TEST_DATABASE_URL;

test(
  "Growth reporting reconciles scoped records and delegates billing metrics",
  { skip: !url },
  async () => {
    const schema = "reporting_" + randomUUID().replaceAll("-", "");
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    const core = { pool, config: readConfig({ DATABASE_URL: url }) };
    const app = await buildApp(core, [
      registerAdminReportingRoutes,
      registerAdminAnalyticsRoutes,
    ]);
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      await pool.query(`SET search_path TO ${schema},public`);
      for (const table of [
        "Organization",
        "OrganizationMember",
        "User",
        "Conversation",
        "AdminUser",
        "AdminSession",
        "AdminSavedReport",
        "AdminReportExportAuditEvent",
        "PublicApiRequest",
      ])
        await pool.query(`CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`);
      await pool.query(`INSERT INTO "AdminUser"(id,name,email,password,role,"updatedAt")VALUES('reader','Reader','reader@example.test','unused','viewer',now()),('owner','Owner','owner@example.test','unused','owner',now()),('other','Other','other@example.test','unused','owner',now());
       INSERT INTO "User"(id,name,email,"updatedAt")VALUES('person','Person','person@example.test',now());
       INSERT INTO "Organization"(id,name,slug,"ownerId","updatedAt")VALUES('org-a','A','a','person',now()),('org-b','B','b','person',now());
       INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt")VALUES('member','org-a','person','OWNER',now());
       INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","createdAt","updatedAt")VALUES('conversation','org-a','web','visitor','2026-10-01',now());
       INSERT INTO "PublicApiRequest"(id,"orgId","principalType","principalId",route,method,"statusCode","createdAt","updatedAt")VALUES('ok','org-a','user','person','/safe','GET',200,'2026-10-01',now()),('failed','org-a','user','person','/safe','GET',503,'2026-10-01',now()),('foreign-api','org-b','user','person','/safe','GET',503,'2026-10-01',now());`);
      const q = parseAdminReportQuery({
        start: "2026-10-01T00:00:00Z",
        end: "2026-10-02T00:00:00Z",
        organizationId: "org-a",
        pageSize: 1,
      });
      const report = await growthAdminReport(pool, q);
      for (const search of ["a", "org-a"]) {
        const found = await growthAdminReport(pool, {
          ...q,
          organizationId: undefined,
          view: "customers",
          customerSearch: search,
          pageSize: 1,
        });
        assert.deepEqual(found.records.map((row) => row.id), ["org-a"]);
      }
      for (const search of ["%", "_", "' OR true --"])
        assert.equal(
          (
            await growthAdminReport(pool, {
              ...q,
              organizationId: undefined,
              view: "customers",
              customerSearch: search,
            })
          ).records.length,
          0,
        );
      assert.throws(
        () => parseAdminReportQuery({ customerSearch: "a" }),
        /Invalid customer search/,
      );
      assert.equal(report.metrics.find((m) => m.key === "organizations")?.value, "1");
      assert.equal(report.metrics.find((m) => m.key === "memberships")?.value, "1");
      assert.equal(report.metrics.find((m) => m.key === "conversations")?.value, "1");
      assert.equal(report.metrics.find((m) => m.key === "active_organizations")?.value, "1");
      assert.equal(report.metrics.find((m) => m.key === "paid")?.value, null);
      assert.equal(
        report.metrics.find((m) => m.key === "paid")?.reason,
        "Central billing owns this metric",
      );
      assert.equal(report.metrics.find((m) => m.key === "operations")?.value, null);
      assert.equal(report.hasMore, true);
      assert.equal(report.records.length, 1);
      assert(!JSON.stringify(report).includes("person@example"));

      const detail = async (
        metric: string,
        dimensions: Record<string, string> = {},
        page = 1,
      ) =>
        growthAdminReport(pool, {
          ...q,
          page,
          detail: { metric, dimensions },
        });
      assert.deepEqual(
        (await detail("memberships")).records.map((row) => [row.id, row.kind]),
        [["member", "membership"]],
      );
      assert.deepEqual(
        (await detail("active_organizations")).records.map((row) => row.id),
        ["ok", "failed"],
      );
      assert.deepEqual(
        (await detail("api_failures")).records.map((row) => [row.id, row.state]),
        [["failed", "503"]],
      );
      assert.equal((await detail("paid", { currency: "ZAR" })).records.length, 0);
      assert.equal((await detail("operations")).records.length, 0);
      assert.equal(
        (await detail('"Organization"; DROP TABLE "User"')).records.length,
        0,
      );

      const path =
        "/api/admin/reporting?" +
        new URLSearchParams({
          start: q.start,
          end: q.end,
          organizationId: "org-a",
        });
      assert.equal((await app.inject(path)).statusCode, 401);
      const token = await createAdminSession(core, "reader");
      const response = await app.inject({
        url: path,
        headers: { cookie: `kasitek_admin_session=${token}` },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().product, "growth");
      assert.equal(
        (
          await app.inject({
            url: path + "&pageSize=1000",
            headers: { cookie: `kasitek_admin_session=${token}` },
          })
        ).statusCode,
        400,
      );

      const owner = await createAdminSession(core, "owner");
      const other = await createAdminSession(core, "other");
      const headers = {
        cookie: `kasitek_admin_session=${owner}`,
        origin: "http://localhost:3001",
      };
      const config = {
        definitionVersion: "1",
        product: "growth",
        domain: "revenue",
        start: q.start,
        end: q.end,
        timezone: q.timezone,
        organizationId: "org-a",
        pageSize: 50,
      };
      const saved = await app.inject({
        method: "POST",
        url: "/api/admin/reports",
        headers,
        payload: { name: "Scoped revenue", reportKey: "cross-product", config },
      });
      assert.equal(saved.statusCode, 201, saved.body);
      const foreign = await app.inject({
        url: "/api/admin/reports",
        headers: { cookie: `kasitek_admin_session=${other}` },
      });
      assert.equal(foreign.json().saved.length, 0);
    } finally {
      await app.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  },
);
