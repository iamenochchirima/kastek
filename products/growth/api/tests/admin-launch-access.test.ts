import { adminFixtureHeaders, seedAdminFixtureSessions } from "./helpers/admin-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { installErrorHandler } from "../src/error.js";
import { apiJson } from "../src/json.js";
import { registerAdminLaunchAccessRoutes } from "../src/routes/admin-launch-access.js";
test(
  "Admin launch access provisions a real organization, trial and invitation; roles/status/resend/revoke match source",
  { skip: !process.env.CORE_ADMIN_ACCESS_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_ADMIN_ACCESS_TEST_DATABASE_URL!,
      fixture = await isolatedDatabase(url, "launch_access", [
        "AdminUser",
        "User",
        "Organization",
        "OrganizationMember",
        "OrganizationInvitation",
        "ReferralCode",
        "CreditAccount",
        "CreditGrant",
        "CreditLedgerEntry",
      ]);
    const { pool } = fixture,
      mail = Fastify(),
      app = Fastify();
    let delivered = 0;
    try {
      await pool.query(
        readFileSync(
          "../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",
          "utf8",
        ),
      );
      await pool.query(readFileSync(new URL("../../database/prisma/migrations/20261023170000_growth_agent_setup/migration.sql",import.meta.url),"utf8"));
      mail.post("/api/v1/send", async (request) => {
        const body = request.body as { To: { Email: string }[]; Text: string };
        assert.equal(body.To[0]!.Email, "fresh@example.test");
        assert.match(body.Text, /\/invite\//);
        delivered++;
        return { ID: "local" };
      });
      const localMail = await mail.listen({ port: 0, host: "127.0.0.1" }),
        config = readConfig({
          DATABASE_URL: url,
          LOCAL_MAILPIT_URL: localMail,
        }),
        core = { pool, config };
      for (const [id, role] of [
        ["admin", "admin"],
        ["viewer", "viewer"],
        ["support", "support"],
      ])
        await pool.query(
          `INSERT INTO "AdminUser"(id,name,email,password,role,"updatedAt")VALUES($1,$1,$1||'@example.test','unused',$2,NOW())`,
          [id, role],
        );
      await seedAdminFixtureSessions(pool);
      await app.register(cookie);
      app.setReplySerializer(apiJson);
      installErrorHandler(app);
      registerAdminLaunchAccessRoutes(app, core);
      const headers = adminFixtureHeaders("admin"),
        request = {
          name: " Fresh User ",
          email: " FRESH@EXAMPLE.TEST ",
          workspaceName: " New workspace ",
        };
      assert.equal(
        (await app.inject({ method: "GET", url: "/api/admin/access" }))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/access",
            headers: adminFixtureHeaders("viewer"),
            payload: request,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/access",
            headers,
            payload: { ...request, email: "invalid" },
          })
        ).statusCode,
        400,
      );
      const created = await app.inject({
        method: "POST",
        url: "/api/admin/access",
        headers,
        payload: request,
      });
      assert.equal(created.statusCode, 201, created.body);
      const result = created.json();
      assert.equal(result.workspace.name, "New workspace");
      assert.equal(result.invitation.email, "fresh@example.test");
      assert.equal(delivered, 1);
      assert.equal((await pool.query('SELECT count(*) FROM "GrowthAgentSetup"')).rows[0].count,"1");
      assert.equal(
        (
          await pool.query(
            'SELECT balance FROM "CreditAccount" WHERE "orgId"=$1',
            [result.workspace.id],
          )
        ).rows[0].balance,
        "1000",
      );
      assert.equal(
        (await pool.query("SELECT COUNT(*) FROM analytics_outbox")).rows[0]
          .count,
        "1",
      );
      assert.equal(
        (
          await pool.query(
            'SELECT role::text FROM "OrganizationMember" WHERE "orgId"=$1',
            [result.workspace.id],
          )
        ).rows[0].role,
        "OWNER",
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/access",
            headers,
            payload: request,
          })
        ).statusCode,
        409,
      );
      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/access",
        headers: adminFixtureHeaders("viewer"),
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().access[0].status, "pending");
      assert(!listed.body.includes("tokenHash"));
      assert(!listed.body.includes("unused"));
      const resend = await app.inject({
        method: "POST",
        url: `/api/admin/access/${result.invitation.id}/resend`,
        headers,
      });
      assert.equal(resend.statusCode, 200, resend.body);
      assert.equal(delivered, 2);
      const replacement = resend.json().invitation.id;
      assert.notEqual(replacement, result.invitation.id);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/admin/access/${replacement}/revoke`,
            headers,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({ method: "GET", url: "/api/admin/access", headers })
        ).json().access[0].status,
        "revoked",
      );
      await pool.query(
        `UPDATE "OrganizationInvitation" SET "acceptedAt"=NOW() WHERE id=$1`,
        [replacement],
      );
      assert.equal(
        (
          await app.inject({ method: "GET", url: "/api/admin/access", headers })
        ).json().access[0].status,
        "active",
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/api/admin/access/${replacement}/revoke`,
            headers,
          })
        ).statusCode,
        404,
      );
      await pool.query(
        `UPDATE "OrganizationInvitation" SET "acceptedAt"=NULL,"revokedAt"=NULL,"expiresAt"=NOW()-INTERVAL '1 day' WHERE id=$1`,
        [replacement],
      );
      assert.equal(
        (
          await app.inject({ method: "GET", url: "/api/admin/access", headers })
        ).json().access[0].status,
        "expired",
      );
      await pool.query(
        `UPDATE "User" SET password='fixture-password' WHERE lower(email)='fresh@example.test'`,
      );
      assert.equal(
        (
          await app.inject({ method: "GET", url: "/api/admin/access", headers })
        ).json().access.length,
        0,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/api/admin/access",
            headers: adminFixtureHeaders("support"),
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/access/missing/resend",
            headers,
          })
        ).statusCode,
        404,
      );
    } finally {
      await app.close();
      await mail.close();
      await fixture.close();
    }
  },
);

test("administrative organisation creation records the durable agent setup intent",{skip:!process.env.CORE_ADMIN_ACCESS_TEST_DATABASE_URL},async()=>{
  const { provisionLaunchUser }=await import("../src/services/admin/launch-access.js");
  const fixture=await isolatedDatabase(process.env.CORE_ADMIN_ACCESS_TEST_DATABASE_URL!,"launch_agent_setup",[
    "User","Organization","OrganizationMember","OrganizationInvitation","ReferralCode","CreditAccount","CreditGrant","CreditLedgerEntry",
  ]);
  const mail=Fastify();mail.post("/api/v1/send",async()=>({ID:"fixture"}));
  try {
    await fixture.pool.query(readFileSync(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",import.meta.url),"utf8"));
    await fixture.pool.query(readFileSync(new URL("../../database/prisma/migrations/20261023170000_growth_agent_setup/migration.sql",import.meta.url),"utf8"));
    const core={pool:fixture.pool,config:readConfig({DATABASE_URL:process.env.CORE_ADMIN_ACCESS_TEST_DATABASE_URL!,LOCAL_MAILPIT_URL:await mail.listen({host:"127.0.0.1",port:0})})};
    const result=await provisionLaunchUser(core,{name:"New User",email:"setup-fixture@example.test",workspaceName:"Setup fixture"});
    const rows=(await fixture.pool.query('SELECT "orgId",status FROM "GrowthAgentSetup"')).rows;
    assert.deepEqual(rows,[{orgId:result.workspace.id,status:"pending"}]);
    assert.equal((await fixture.pool.query('SELECT count(*) FROM "OrganizationMember" WHERE "orgId"=$1',[result.workspace.id])).rows[0].count,"1");
  } finally {await mail.close();await fixture.close();}
});
