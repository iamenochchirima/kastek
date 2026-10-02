import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { parse } from "csv-parse/sync";
import { readConfig } from "../src-ts/config.js";
import { installPgTimestampParsers, UtcTimestamp } from "../src-ts/db.js";
import { apiJson } from "../src-ts/json.js";
import { installErrorHandler } from "../src-ts/error.js";
import {
  reportWindow,
  humanizeKey,
  overview,
  usage,
  revenue,
  customers,
} from "../src-ts/services/admin/analytics.js";
import {
  listReports,
  saveReport,
  removeReport,
  exportReport,
} from "../src-ts/services/admin/reports.js";
import {
  listActivity,
  streamActivity,
  encodeActivityCursor,
  decodeActivityCursor,
  validateActivityQuery,
} from "../src-ts/services/admin/activity.js";
import {
  registerAdminAnalyticsRoutes,
  signedInteger,
} from "../src-ts/routes/admin-analytics.js";
import { SerdeFloat } from "@kasitek/server-support/json";
test("Admin reporting bounds, lossless integer DTOs and microsecond activity cursor contract", () => {
  const w = reportWindow(2n, new Date("2026-10-02T12:34:56Z"));
  assert.equal(w.start.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.throws(() => reportWindow(367));
  assert.throws(() => signedInteger(new SerdeFloat(2)));
  assert.equal(
    signedInteger("9223372036854775807", true),
    9223372036854775807n,
  );
  assert.equal(humanizeKey("whatsapp-message.sent"), "Whatsapp Message Sent");
  const cursor = encodeActivityCursor(
    new UtcTimestamp("2026-10-02T12:34:56.123456+00:00", true),
    "event",
  );
  assert.equal(
    decodeActivityCursor(cursor)!.occurredAt.toISOString(),
    "2026-10-02T12:34:56.123456Z",
  );
  assert.equal(decodeActivityCursor("invalid"), null);
  assert.throws(() => validateActivityQuery({ limit: 101 }));
  assert.throws(() => validateActivityQuery({ domain: " " }));
});
test(
  "Admin aggregate privacy, all report exports, creator isolation, role restrictions and stream events",
  { skip: !process.env.CORE_ADMIN_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const connectionString = process.env.CORE_ADMIN_TEST_DATABASE_URL!,
      schema = `admin_reporting_test_${randomUUID().replaceAll("-", "")}`,
      admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
        connectionString,
        max: 2,
        options: `-c search_path=${schema} -c timezone=UTC`,
      }),
      config = readConfig({ DATABASE_URL: connectionString }),
      core = { pool, config },
      app = Fastify();
    app.setReplySerializer(apiJson);
    installErrorHandler(app);
    await app.register(cookie);
    try {
      const queries = ["analytics", "reports", "activity"]
          .map((name) =>
            readFileSync(`src-ts/services/admin/${name}-sql.ts`, "utf8"),
          )
          .join("\n"),
        tables = [
          ...new Set(
            [
              ...queries
                .replaceAll('\\"', '"')
                .matchAll(
                  /(?:FROM|JOIN|INSERT INTO|UPDATE|DELETE FROM) "([A-Za-z][A-Za-z0-9]+)"/g,
                ),
            ].map((match) => match[1]!),
          ),
        ];
      assert(tables.includes("UsageEvent"));
      for (const table of tables)
        await pool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      for (const [id, role] of [
        ["admin", "admin"],
        ["viewer", "viewer"],
        ["other", "owner"],
        ["invalid", "invalid"],
      ])
        await pool.query(
          `INSERT INTO "AdminUser"(id,name,email,password,role,"updatedAt")VALUES($1,$1,$1||'@example.test','fixture',$2,NOW())`,
          [id, role],
        );
      await pool.query(
        `INSERT INTO "User"(id,name,email,"emailVerified","updatedAt")VALUES('user','Fixture','user@example.test',NOW(),NOW());INSERT INTO "Organization"(id,name,slug,"ownerId","updatedAt")VALUES('org','Fixture organization','fixture','user',NOW())`,
      );
      await pool.query(
        `INSERT INTO "UsageEvent"(id,"orgId","productKey","metricKey",quantity,"occurredAt")VALUES('usage','org','workspace','message.sent',5,NOW())`,
      );
      await pool.query(
        `INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","customerName",status,"lastMessageAt","createdAt","updatedAt")VALUES('conversation','org','whatsapp','wa:connection:+27821234567','Private customer','active',NOW(),NOW(),NOW());INSERT INTO "Message"(id,"conversationId",sender,content,"contentType",timestamp)VALUES('message','conversation','customer','DO NOT EXPOSE PRIVATE CUSTOMER CONTENT','TEXT',NOW())`,
      );
      await pool.query(
        `INSERT INTO "CreditLedgerEntry"(id,"accountId","orgId",type,amount,"balanceAfter","sourceType",metadata,"createdAt")VALUES('ledger','fixture-account','org','GRANT',9007199254740993,9007199254740993,'SYSTEM','{}',NOW())`,
      );
      const overviewResult = await overview(pool, 1),
        usageResult = await usage(pool, 1),
        revenueResult = await revenue(pool, 1),
        customersResult = await customers(pool, 1);
      assert.equal(overviewResult.kpis.operations, 5);
      assert.equal(overviewResult.daily.length, 1);
      assert.equal(
        usageResult.kpis.messages,
        1,
        apiJson({ daily: usageResult.daily, kpis: usageResult.kpis }),
      );
      assert.equal(customersResult.kpis.activeOrganizations, 1);
      assert.equal(revenueResult.kpis.paidInvoices, 0);
      assert.equal(revenueResult.creditLifecycle[0].amount, 9007199254740993n);
      assert.match(apiJson(revenueResult), /9007199254740993/);
      assert(!apiJson(overviewResult).includes("DO NOT EXPOSE"));
      assert(!apiJson(customersResult).includes("Private customer"));
      const saved = await saveReport(
        pool,
        { id: "admin", name: "Admin" },
        {
          name: "Overview fixture",
          reportKey: "platform-overview",
          days: 1,
          config: { clientSetting: "value", version: 99, days: 99 },
        },
      );
      assert.equal(saved.config.version, 1);
      assert.equal(saved.config.days, 1);
      assert.equal((await listReports(pool, "other")).saved.length, 0);
      await assert.rejects(() => removeReport(pool, "other", saved.id));
      assert.equal((await listReports(pool, "admin")).saved.length, 1);
      for (const key of [
        "platform-overview",
        "usage-daily",
        "revenue-daily",
        "customer-cohorts",
      ]) {
        const result = await exportReport(pool, "admin", key, 1),
          csv = parse(result.bytes, { columns: true });
        assert(csv.length >= 1);
        assert(!result.bytes.toString().includes("DO NOT EXPOSE"));
        if (key === "customer-cohorts")
          assert.equal(csv[0].organization_id, "org");
      }
      assert.equal(
        (
          await pool.query(
            `SELECT count(*) FROM "AdminReportExportAuditEvent" WHERE status='SUCCEEDED'`,
          )
        ).rows[0].count,
        "4",
      );
      await pool.query(
        `ALTER TABLE "CommunicationCall" RENAME TO "UnavailableCallsFixture"`,
      );
      await assert.rejects(() => exportReport(pool, "admin", "usage-daily", 1));
      await pool.query(
        `ALTER TABLE "UnavailableCallsFixture" RENAME TO "CommunicationCall"`,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*) FROM "AdminReportExportAuditEvent" WHERE status='FAILED'`,
          )
        ).rows[0].count,
        "1",
      );
      const activity = await listActivity(pool, {
        days: 1,
        limit: 1,
        organizationId: "org",
      });
      assert.equal(activity.hasMore, true);
      assert.equal(activity.items.length, 1);
      const next = await listActivity(pool, {
        days: 1,
        limit: 100,
        cursor: activity.nextCursor,
        organizationId: "org",
      });
      assert(!next.items.some((item: any) => item.id === activity.items[0].id));
      assert(!apiJson(next).includes("DO NOT EXPOSE"));
      assert.equal(
        (await listActivity(pool, { days: 1, organizationId: "foreign" })).items
          .length,
        0,
      );
      const controller = new AbortController(),
        stream = streamActivity(
          pool,
          { days: 1, limit: 100, organizationId: "org" },
          controller.signal,
        );
      const first = await stream.next();
      assert.match(first.value!, /^event: activity\ndata: /);
      assert(!first.value!.includes("DO NOT EXPOSE"));
      controller.abort();
      await stream.return(undefined);
      await registerAdminAnalyticsRoutes(app, core);
      assert.equal(
        (await app.inject({ url: "/api/admin/analytics/overview?days=1" }))
          .statusCode,
        401,
      );
      const viewer = { cookie: "kasitek_admin_session=viewer" },
        owner = { cookie: "kasitek_admin_session=admin" };
      assert.equal(
        (
          await app.inject({
            url: "/api/admin/analytics/overview?days=1",
            headers: viewer,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/admin/analytics/overview?days=1",
            headers: { cookie: "kasitek_admin_session=invalid" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/reports",
            headers: viewer,
            payload: { name: "Saved", reportKey: "usage-daily" },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/admin/reports/export?report=usage-daily&days=1",
            headers: viewer,
          })
        ).statusCode,
        403,
      );
      const exported = await app.inject({
        url: "/api/admin/reports/export?report=usage-daily&days=1",
        headers: owner,
      });
      assert.equal(exported.statusCode, 200, exported.body);
      assert.equal(exported.headers["cache-control"], "no-store");
      await removeReport(pool, "admin", saved.id);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
