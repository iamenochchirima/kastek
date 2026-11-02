import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { encryptWithAes256Gcm } from "@kasitek-labs/server-support/crypto";
import { processDueDeliveries } from "../src/services/public-webhooks.js";
import { readFileSync } from "node:fs";
import pg from "pg";
import {
  customerOverview,
  customerCollection,
  executeCustomerOperation,
  approveCustomerOperation,
  customerReceipt,
} from "../src/services/admin/customers.js";
import {
  createSupportGrant,
  revokeSupportGrant,
} from "../src/services/admin/support-access.js";
import { getConversation } from "../src/services/admin/conversations.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { registerAdminCustomerRoutes } from "../src/routes/admin-customers.js";
import {
  seedAdminFixtureSessions,
  adminFixtureHeaders,
} from "./helpers/admin-fixture.js";
const database = process.env.CORE_ADMIN_CUSTOMERS_TEST_DATABASE_URL;
test(
  "customer operations: scoped reads, transactional recovery, distinct approvals, durable outcomes and support audit",
  { skip: !database },
  async () => {
    const schema = "customer_ops_" + randomUUID().replaceAll("-", "");
    const admin = new pg.Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: database,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    const secret = "controlled-webhook-secret-" + randomUUID(),
      encryptionKey = randomUUID();
    const received: {
      body: Buffer;
      signature: string | undefined;
      timestamp: string | undefined;
      eventId: string | undefined;
    }[] = [];
    const receiver = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          body: Buffer.concat(chunks),
          signature: request.headers["x-kasitek-webhook-signature"] as
            | string
            | undefined,
          timestamp: request.headers["x-kasitek-webhook-timestamp"] as
            | string
            | undefined,
          eventId: request.headers["x-kasitek-webhook-id"] as
            | string
            | undefined,
        });
        response.writeHead(204);
        response.end();
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        receiver.once("error", reject);
        receiver.listen(0, "127.0.0.1", () => resolve());
      });
      const address = receiver.address();
      assert.ok(address && typeof address === "object");
      await pool.query(
        `CREATE TABLE "Organization"(id text PRIMARY KEY,name text);CREATE TABLE "AdminUser"(id text PRIMARY KEY,name text,email text,password text,role text,"updatedAt" timestamp);CREATE TABLE "Customer"(id text PRIMARY KEY,"orgId" text);CREATE TABLE "Conversation"(id text PRIMARY KEY,"orgId" text,"customerId" text,channel text,"customerIdentifier" text,"customerName" text,status text,"lastMessageAt" timestamp,"createdAt" timestamp);CREATE TABLE "Message"(id text,"conversationId" text,sender text,content text,timestamp timestamp);CREATE TABLE "CreditAccount"(id text,"orgId" text,balance bigint,"reservedBalance" bigint);CREATE TABLE "CreditGrant"(id text,"orgId" text,source text,"remainingAmount" bigint,"startsAt" timestamp,"endsAt" timestamp);CREATE TABLE "CreditLedgerEntry"(id text,"orgId" text,type text,amount bigint,"balanceAfter" bigint,"createdAt" timestamp);CREATE TABLE "PublicApiWebhookSubscription"(id text PRIMARY KEY,"orgId" text,status text);CREATE TABLE "PublicApiWebhookDelivery"(id text PRIMARY KEY,"subscriptionId" text,"eventId" text,"eventType" text,status text,"attemptCount" int,"nextAttemptAt" timestamp,"lastStatusCode" int,"lastError" text,"deliveredAt" timestamp,"updatedAt" timestamp);`,
      );
      for (const migration of [
        "20260814170000_add_admin_support_access",
        "20260814180000_add_admin_webhook_replay",
        "20261023130000_admin_customer_operations",
      ])
        await pool.query(
          readFileSync(
            new URL(
              `../../database/prisma/migrations/${migration}/migration.sql`,
              import.meta.url,
            ),
            "utf8",
          ),
        );
      await pool.query(
        `INSERT INTO "Organization" VALUES('a','Customer A'),('b','Customer B');INSERT INTO "AdminUser" VALUES('operator','Operator','op@example.test','x','operator',now()),('second','Second','second@example.test','x','operator',now()),('viewer','Viewer','view@example.test','x','viewer',now());INSERT INTO "PublicApiWebhookSubscription" VALUES('sub','a','ACTIVE'),('sub-b','b','ACTIVE');INSERT INTO "PublicApiWebhookDelivery"(id,"subscriptionId","eventType",status,"attemptCount","updatedAt") VALUES('d1','sub','event.test','FAILED',3,now()),('d2','sub','event.test','FAILED',4,now()),('d3','sub','event.test','FAILED',3,now()),('other','sub-b','event.test','FAILED',3,now());INSERT INTO "CreditAccount" VALUES('account','a',9007199254740993,3);INSERT INTO "CreditGrant" VALUES('expired','a','MANUAL',7,now()-interval '1 month',now()-interval '1 day');INSERT INTO "Conversation" VALUES('conversation','a',NULL,'web','private-identity','Private','open',now(),now());INSERT INTO "Message" VALUES('message','conversation','user','DO NOT AUDIT THIS BODY',now());`,
      );

      await pool.query(
        `ALTER TABLE "PublicApiWebhookSubscription" ADD COLUMN url text, ADD COLUMN "secretCiphertext" text,ADD COLUMN "failureCount" int DEFAULT 0,ADD COLUMN "lastDeliveredAt" timestamp,ADD COLUMN "updatedAt" timestamp;ALTER TABLE "PublicApiWebhookDelivery" ADD COLUMN payload jsonb DEFAULT '{}',ADD COLUMN "createdAt" timestamp DEFAULT now()`,
      );
      await pool.query(
        `UPDATE "PublicApiWebhookSubscription" SET url=$1,"secretCiphertext"=$2`,
        [
          `http://127.0.0.1:${address.port}/webhook`,
          encryptWithAes256Gcm(encryptionKey, secret),
        ],
      );
      await pool.query(
        `UPDATE "PublicApiWebhookDelivery" SET "eventId"='fixture-recovery-event',payload='{"event":"controlled-recovery"}' WHERE id='d1'`,
      );
      const first = await customerOverview(pool, "a");
      assert.equal(first.customer.id, "a");
      assert.equal(first.customer.state, "present");
      assert.equal(
        first.sections.find((x) => x.id === "credits")!.records[0]!.facts[0]!
          .value,
        "9007199254740993",
      );
      await customerOverview(pool, "a");
      assert.equal(
        (
          await pool.query(
            `SELECT "remainingAmount"::text AS amount FROM "CreditGrant" WHERE id='expired'`,
          )
        ).rows[0].amount,
        "7",
      );
      assert.equal(
        (await pool.query(`SELECT count(*) FROM "CreditLedgerEntry"`)).rows[0]
          .count,
        "0",
      );
      const page = await customerCollection(pool, "a", "failures", {
        limit: "1",
      });
      assert.equal(page.records.length, 1);
      assert.ok(page.nextCursor);
      assert.equal(
        (
          await customerCollection(pool, "a", "failures", {
            limit: "1",
            cursor: page.nextCursor,
          })
        ).records[0]!.id,
        "d2",
      );
      const request = {
        operationId: "request_0001",
        action: "webhook.replay" as const,
        label: "Replay webhook",
        targetId: "d1",
        expected: { status: "FAILED", attemptCount: 3 },
        reason: "Customer support recovery",
      };
      const created = await executeCustomerOperation(
        pool,
        "a",
        "operator",
        request,
      );
      assert.equal(created.status, "awaiting_approval");
      const race = await Promise.allSettled(
        ["parallel_0001", "parallel_0002"].map((operationId) =>
          executeCustomerOperation(pool, "a", "operator", {
            ...request,
            operationId,
            targetId: "d3",
          }),
        ),
      );
      assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(race.filter((x) => x.status === "rejected").length, 1);
      assert.equal(
        (
          await pool.query(
            `SELECT count(*) FROM "AdminWebhookReplayCommand" WHERE "deliveryId"='d3'`,
          )
        ).rows[0].count,
        "1",
      );
      await assert.rejects(
        executeCustomerOperation(pool, "a", "operator", {
          ...request,
          operationId: "new_request_same_delivery",
        }),
        /already active/,
      );
      assert.equal(
        (await customerCollection(pool, "a", "failures", {})).records.find(
          (r) => r.id === "d1",
        )!.actions!.length,
        0,
      );
      assert.equal(
        (await executeCustomerOperation(pool, "a", "operator", request)).id,
        created.id,
      );
      await assert.rejects(
        executeCustomerOperation(pool, "a", "operator", {
          ...request,
          reason: "A different reason",
        }),
        /different/,
      );
      await assert.rejects(
        executeCustomerOperation(pool, "a", "second", request),
        /different/,
      );
      await assert.rejects(
        executeCustomerOperation(pool, "a", "operator", {
          ...request,
          operationId: "request_other",
          targetId: "other",
        }),
        /not found/,
      );
      await assert.rejects(customerReceipt(pool, "b", created.id), /not found/);
      const approval = {
        operationId: "approval_0001",
        action: "webhook.replay.approve" as const,
        label: "Approve replay",
        targetId: created.id,
        expected: { status: "awaiting_approval" },
        reason: "Second operator confirms",
      };
      await assert.rejects(
        approveCustomerOperation(pool, "a", created.id, "operator", approval),
        /distinct/,
      );
      assert.equal(
        (await pool.query(`SELECT count(*) FROM "AdminCustomerReplayApproval"`))
          .rows[0].count,
        "0",
      );
      const approved = await approveCustomerOperation(
        pool,
        "a",
        created.id,
        "second",
        approval,
      );
      assert.equal(approved.status, "pending");
      assert.equal(approved.id, approval.operationId);
      assert.equal(
        (await customerReceipt(pool, "a", approval.operationId)).actorId,
        "second",
      );
      assert.equal(
        (await customerReceipt(pool, "a", approval.operationId)).action,
        "webhook.replay.approve",
      );
      assert.equal(
        (
          await approveCustomerOperation(
            pool,
            "a",
            created.id,
            "second",
            approval,
          )
        ).status,
        "pending",
      );
      await assert.rejects(
        approveCustomerOperation(pool, "a", created.id, "second", {
          ...approval,
          reason: "Changed approval reason",
        }),
        /different/,
      );

      const workerConfig = readConfig({
        DATABASE_URL: database!,
        NODE_ENV: "test",
        ENVIRONMENT: "development",
        PUBLIC_WEBHOOK_ENCRYPTION_KEY: encryptionKey,
      });
      assert.equal(
        (await customerReceipt(pool, "a", created.id)).status,
        "pending",
      );
      assert.equal(received.length, 0);
      assert.equal(await processDueDeliveries(pool, workerConfig, 10), 1);
      assert.equal(received.length, 1);
      assert.equal(received[0]!.eventId, "fixture-recovery-event");
      assert.deepEqual(JSON.parse(received[0]!.body.toString("utf8")), {
        event: "controlled-recovery",
      });
      assert.ok(received[0]!.timestamp);
      const expectedSignature =
        "v1=" +
        createHmac("sha256", secret)
          .update(received[0]!.timestamp!)
          .update(".")
          .update(received[0]!.body)
          .digest("hex");
      assert.equal(received[0]!.signature, expectedSignature);
      const delivered = (
        await pool.query(
          `SELECT status,"attemptCount","lastStatusCode","deliveredAt" FROM "PublicApiWebhookDelivery" WHERE id='d1'`,
        )
      ).rows[0];
      assert.equal(delivered.status, "DELIVERED");
      assert.equal(delivered.attemptCount, 1);
      assert.equal(delivered.lastStatusCode, 204);
      assert.ok(delivered.deliveredAt);
      assert.equal(await processDueDeliveries(pool, workerConfig, 10), 0);
      assert.equal(received.length, 1);

      assert.equal(
        (await customerReceipt(pool, "a", created.id)).status,
        "confirmed",
      );
      await pool.query(
        `UPDATE "PublicApiWebhookDelivery" SET status='FAILED' WHERE id='d1'`,
      );
      assert.equal(
        (await customerReceipt(pool, "a", created.id)).status,
        "confirmed",
      );
      await pool.query(
        `CREATE FUNCTION fail_replay_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;CREATE TRIGGER fail_replay_audit BEFORE INSERT ON "AdminWebhookReplayAuditEvent" FOR EACH ROW EXECUTE FUNCTION fail_replay_audit()`,
      );
      await assert.rejects(
        executeCustomerOperation(pool, "a", "operator", {
          ...request,
          operationId: "request_rollback",
          targetId: "d2",
          expected: { status: "FAILED", attemptCount: 4 },
        }),
        /audit unavailable/,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*) FROM "AdminWebhookReplayCommand" WHERE "operationId"='request_rollback'`,
          )
        ).rows[0].count,
        "0",
      );
      await pool.query(
        `DROP TRIGGER fail_replay_audit ON "AdminWebhookReplayAuditEvent"`,
      );
      const actor = { id: "operator", role: "operator" } as any;
      await assert.rejects(
        createSupportGrant(pool, actor, {
          adminId: "operator",
          organizationId: "b",
          resourceType: "conversation",
          resourceId: "conversation",
          reason: "Scoped support",
          durationMinutes: 5,
        }),
        /not found/,
      );
      const grant = await createSupportGrant(pool, actor, {
        adminId: "operator",
        organizationId: "a",
        resourceType: "conversation",
        resourceId: "conversation",
        reason: "Scoped support",
        durationMinutes: 5,
      });
      await getConversation(pool, "operator", "conversation");
      const audits = (
        await pool.query(
          `SELECT metadata FROM "AdminSupportAccessAuditEvent" WHERE action='content_read'`,
        )
      ).rows;
      assert.equal(audits.length, 1);
      assert.ok(!JSON.stringify(audits).includes("DO NOT AUDIT"));
      await pool.query(
        `CREATE FUNCTION fail_support_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$;CREATE TRIGGER fail_support_audit BEFORE INSERT ON "AdminSupportAccessAuditEvent" FOR EACH ROW EXECUTE FUNCTION fail_support_audit()`,
      );
      await assert.rejects(
        createSupportGrant(pool, actor, {
          adminId: "second",
          organizationId: "a",
          resourceType: "organization",
          reason: "Scoped support rollback",
          durationMinutes: 5,
        }),
        /audit unavailable/,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*) FROM "AdminSupportAccessGrant" WHERE "adminId"='second'`,
          )
        ).rows[0].count,
        "0",
      );
      await assert.rejects(
        getConversation(pool, "operator", "conversation"),
        /audit unavailable/,
      );
      await assert.rejects(
        revokeSupportGrant(pool, actor, grant.id),
        /audit unavailable/,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT "revokedAt" FROM "AdminSupportAccessGrant" WHERE id=$1`,
            [grant.id],
          )
        ).rows[0].revokedAt,
        null,
      );
      await pool.query(
        `DROP TRIGGER fail_support_audit ON "AdminSupportAccessAuditEvent"`,
      );
      await revokeSupportGrant(pool, actor, grant.id);
      await assert.rejects(
        getConversation(pool, "operator", "conversation"),
        /grant/,
      );
      await pool.query(
        `ALTER TABLE "AdminUser" ADD COLUMN "createdAt" timestamp DEFAULT now()`,
      );
      await seedAdminFixtureSessions(pool);
      app = await buildApp(
        {
          pool,
          config: readConfig({
            DATABASE_URL: database!,
            LOG_LEVEL: "silent",
            NODE_ENV: "test",
            KASITEK_CUSTOMER_OPERATIONS: "1",
            KASITEK_CUSTOMER_ACTIONS: "webhook.replay,webhook.replay.approve",
          }),
        },
        [registerAdminCustomerRoutes],
      );
      assert.equal(
        (
          await app.inject({
            url: "/api/admin/customers/a",
            headers: adminFixtureHeaders("viewer"),
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/customers/a/operations",
            headers: adminFixtureHeaders("viewer"),
            payload: request,
          })
        ).statusCode,
        403,
      );
      const replayHttp = await app.inject({
        method: "POST",
        url: "/api/admin/customers/a/operations",
        headers: adminFixtureHeaders("operator"),
        payload: request,
      });
      assert.equal(replayHttp.statusCode, 200, replayHttp.body);
      assert.equal(
        (
          await app.inject({
            url: "/api/admin/customers/a/failures?limit=101",
            headers: adminFixtureHeaders("viewer"),
          })
        ).statusCode,
        400,
      );
    } finally {
      await app?.close();
      receiver.closeAllConnections();
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
