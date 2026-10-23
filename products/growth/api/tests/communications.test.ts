import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import pg from "pg";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { installErrorHandler } from "../src/error.js";
import { apiJson } from "../src/json.js";
import { parseRequestJson } from "../src/identity/json-body.js";
import { registerCommunicationsRoutes } from "../src/routes/communications.js";
import * as calls from "../src/services/communications/calls.js";
const config = () =>
  readConfig({
    DATABASE_URL: "postgresql://fixture",
    TWILIO_ACCOUNT_SID: "ACfixture",
    TWILIO_AUTH_TOKEN: "fixture-secret",
    TWILIO_API_KEY_SID: "SKfixture",
    TWILIO_API_KEY_SECRET: "key-secret",
    TWILIO_TWIML_APP_SID: "APfixture",
    TWILIO_VOICE_WEBHOOK_URL:
      "https://voice.example.test/api/webhooks/twilio/voice",
    TWILIO_BROWSER_TWIML_URL:
      "https://browser.example.test/api/webhooks/twilio/browser",
  });
function signature(base: string, path: string, body: Record<string, string>) {
  return createHmac("sha1", "fixture-secret")
    .update(
      base +
        path +
        Object.keys(body)
          .sort()
          .map((key) => key + body[key])
          .join(""),
    )
    .digest("base64");
}
test("Twilio JWT grants, strict signature, browser scopes and exact TwiML contracts", () => {
  const c = config(),
    token = calls.createTwilioBrowserToken(c, "org", "user"),
    parts = token.token.split(".");
  assert.equal(
    parts[2],
    createHmac("sha256", "key-secret")
      .update(parts[0] + "." + parts[1])
      .digest("base64url"),
  );
  const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString());
  assert.equal(claims.exp - claims.iat, 3600);
  assert.equal(claims.grants.identity, "kasitek_org_user");
  assert.deepEqual(claims.grants.voice, {
    incoming: { allow: true },
    outgoing: { application_sid: "APfixture" },
  });
  const path = "/api/webhooks/twilio/status",
    body = { CallSid: "CA1", To: "+27821234567", CallStatus: "completed" };
  const sig = signature("https://browser.example.test", path, body);
  calls.verifyTwilioWebhook(c, path, body, sig);
  for (const invalid of [
    sig.replace("=", ""),
    sig + "\n",
    sig.slice(1),
    undefined,
  ])
    assert.throws(() => calls.verifyTwilioWebhook(c, path, body, invalid));
  assert.throws(() =>
    calls.verifyTwilioWebhook(c, path, { ...body, CallSid: "CA2" }, sig),
  );
  assert.equal(
    calls.twilioOrgFromIdentity("client:kasitek_org_user_more"),
    "org",
  );
  assert.throws(() => calls.twilioOrgFromIdentity("client:other_user"));
  assert.throws(() => calls.twilioOrgFromIdentity("kasitek_org_"));
  assert.equal(calls.validateE164Phone(" +01234567 "), "+01234567");
  assert.throws(() => calls.validateE164Phone("0712345678"));
  assert.equal(calls.normalizeTwilioStatus("IN-PROGRESS"), "ACTIVE");
  assert.equal(calls.normalizeTwilioStatus("no-answer"), "MISSED");
  assert.equal(
    calls.inboundTwiml(c),
    '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
  );
  c.env.TWILIO_INBOUND_FALLBACK_NUMBER = `<&"'>`;
  assert.match(calls.inboundTwiml(c), /&lt;&amp;&quot;&apos;&gt;/);
  assert.match(
    calls.browserTwiml(c, "+2782", "+2783"),
    /statusCallback="https:\/\/browser.example.test\/api\/webhooks\/twilio\/status"/,
  );
  assert.equal(calls.providerStatus(c).providers[0]!.configured, true);
});
test(
  "Twilio persisted lifecycle, call status idempotency and org scope; retired Telegram callback is unavailable",
  { skip: !process.env.CORE_COMMUNICATIONS_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const connectionString = process.env.CORE_COMMUNICATIONS_TEST_DATABASE_URL!,
      schema = "communications_test_" + randomUUID().replaceAll("-", ""),
      admin = new pg.Pool({ connectionString, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
        connectionString,
        max: 2,
        options: `-c search_path=${schema} -c timezone=UTC`,
      }),
      app = Fastify(),
      c = config();
    try {
      for (const table of [
        "ExternalConnection",
        "CommunicationCall",
        "WhatsappCallSession",
        "WhatsappConnection",
        "Conversation",
      ])
        await pool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      await pool.query(
        readFileSync(
          "../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",
          "utf8",
        ),
      );
      const connection = await calls.createTwilioConnection(pool, "org", {
        phoneNumber: " +27821234567 ",
        displayName: " Voice ",
      });
      const repeated = await calls.createTwilioConnection(pool, "org", {
        phoneNumber: "+27821234567",
        displayName: "Updated",
      });
      assert.equal(repeated.id, connection.id);
      assert.equal(
        (await pool.query("SELECT COUNT(*) FROM analytics_outbox")).rows[0]
          .count,
        "1",
      );
      await pool.query(
        `UPDATE "ExternalConnection" SET status='CONNECTED' WHERE id=$1`,
        [connection.id],
      );
      await calls.createTwilioConnection(pool, "org", {
        phoneNumber: "+27821234567",
      });
      assert.equal(
        (
          await pool.query(
            'SELECT status FROM "ExternalConnection" WHERE id=$1',
            [connection.id],
          )
        ).rows[0].status,
        "CONNECTED",
      );
      const body = {
        CallSid: "child",
        ParentCallSid: "parent",
        To: "+27 (82) 123-4567",
        From: "+27820000000",
        CallStatus: "in-progress",
        CallDuration: "10",
      };
      const first = await calls.recordTwilioWebhook(pool, body);
      assert.equal(first!.status, "ACTIVE");
      const done = await calls.recordTwilioWebhook(pool, {
        ...body,
        CallStatus: "completed",
        CallDuration: "999999999999",
      });
      assert.equal(done!.callId, first!.callId);
      const rows = await calls.listCalls(pool, "org");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.durationSeconds, 10);
      assert.equal(rows[0]!.providerCallId, "parent");
      assert(rows[0]!.endedAt);
      assert.equal((await calls.listCalls(pool, "other")).length, 0);
      const summary = await calls.callSummary(pool, "org", 999n);
      assert.equal(summary.days, 90);
      assert.equal(summary.summary.completedCalls, 1n);
      await assert.rejects(() =>
        calls.recordTwilioBrowserCall(pool, c, {
          From: "client:kasitek_other_user",
          ConnectionId: connection.id,
          To: "+27821111111",
          CallSid: "browser",
        }),
      );
      assert.match(
        await calls.recordTwilioBrowserCall(pool, c, {
          From: "client:kasitek_org_user",
          ConnectionId: connection.id,
          To: "+27821111111",
          CallSid: "browser",
        }),
        /<Number>\+27821111111<\/Number>/,
      );
      assert.equal((await calls.listCalls(pool, "org")).length, 2);
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","updatedAt")VALUES('wa','user','org','phone','unused','waba',NOW());INSERT INTO "WhatsappCallSession"(id,"userId","connectionId",direction,status,"waCallId","fromPhone","toPhone","updatedAt")VALUES('session','user','wa','INBOUND','RINGING','wa-call','+27820000000','+27821234567',NOW())`,
      );
      const projected = (await calls.listCalls(pool, "org")).find(
        (row) => row.provider === "WHATSAPP",
      )!;
      assert.equal(projected.id, "call_session");
      assert.equal(projected.providerCallId, "wa-call");
      assert.equal(projected.status, "RINGING");
      await pool.query(
        `UPDATE "WhatsappCallSession" SET status='COMPLETED',direction='OUTBOUND',"durationSeconds"=5,"endedAt"=NOW() WHERE id='session'`,
      );
      const updated = (await calls.listCalls(pool, "org")).find(
        (row) => row.provider === "WHATSAPP",
      )!;
      assert.equal(updated.status, "COMPLETED");
      assert.equal(updated.durationSeconds, 5);
      assert.equal(updated.direction, "INBOUND");
      assert.equal((await calls.listCalls(pool, "other")).length, 0);
      app.setReplySerializer(apiJson);
      installErrorHandler(app);
      app.removeContentTypeParser("application/json");
      app.addContentTypeParser(
        "application/json",
        { parseAs: "string" },
        (request, body, done) => {
          try {
            done(null, parseRequestJson(request, body as string));
          } catch (error) {
            done(error as Error);
          }
        },
      );
      await app.register(formbody);
      await registerCommunicationsRoutes(app, { pool, config: c });
      const denied = await app.inject({
        method: "POST",
        url: "/api/webhooks/twilio/status",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams(body).toString(),
      });
      assert.equal(denied.statusCode, 401);
      const path = "/api/webhooks/twilio/status",
        signed = signature("https://browser.example.test", path, body);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: path,
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              "x-twilio-signature": signed,
            },
            payload: new URLSearchParams(body).toString(),
          })
        ).statusCode,
        204,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/webhooks/telegram/connection",
            headers: {
              "content-type": "application/json",
              "x-telegram-bot-api-secret-token": "provider-secret",
            },
            payload: '{"update_id":9007199254740993,"value":1.0}',
          })
        ).statusCode,
        404,
      );
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
