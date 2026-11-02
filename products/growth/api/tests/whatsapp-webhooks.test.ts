import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import pg from "pg";
import Fastify from "fastify";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { installErrorHandler } from "../src/error.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import * as n from "../src/services/whatsapp/webhook-normalization.js";
import { handleStatus } from "../src/services/whatsapp/webhooks-status.js";
import {
  handleIncomingMessages,
  processWebhookPayload,
  type WhatsappWebhookOptions,
} from "../src/services/whatsapp/webhooks.js";
import {
  registerWhatsappWebhookRoutes,
  verifyWhatsappWebhookRequest,
} from "../src/routes/whatsapp-webhooks.js";
import { syncConnectionTemplates } from "../src/services/whatsapp/templates.js";
import { createCampaign } from "../src/services/whatsapp/campaigns.js";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
test("WhatsApp webhook normalization preserves bounded error/pricing, provider media metadata and marketing contracts", () => {
  assert.equal(
    n.inboundText({ text: { body: "hello" }, button: { text: "button" } }),
    "hello",
  );
  assert.equal(n.isOptOutMessage(" STOP "), true);
  assert.equal(n.isOptOutMessage("stop please"), false);
  assert.deepEqual(
    n.parseStatusFailureDetails({
      errors: [
        {
          code: 9223372036854775807n,
          title: " title ",
          message: " message ",
          error_data: { details: " details " },
        },
      ],
    }),
    ["9223372036854775807", "title | message | details"],
  );
  assert.equal(
    n.parseStatusFailureDetails({
      errors: [{ code: new SerdeFloat(131026) }],
    })[0],
    null,
  );
  assert.equal(n.isBlockedFailure("131026", null), true);
  assert.equal(
    n.parseStatusPricingDetails({
      pricing: { billable: true, category: "marketing/category" },
    }),
    null,
  );
  assert.deepEqual(
    n.parseStatusPricingDetails({
      pricing: {
        billable: true,
        category: "marketing",
        pricing_model: "CBP",
        type: "regular",
      },
    }),
    {
      billable: true,
      category: "marketing",
      model: "CBP",
      pricingType: "regular",
    },
  );
  const media = n.incomingMedia({
    document: {
      id: "media",
      filename: "PHOTO.JPG",
      mime_type: "application/octet-stream",
    },
  })!;
  assert.equal(media.kind,"document");
  assert.equal(media.mediaId,"media");
  assert.equal(media.filename,"PHOTO.JPG");
  const core = {
    config: readConfig({
      DATABASE_URL: "postgres://fixture",
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: "raw token ",
    }),
    pool: null as any,
  };
  assert.equal(
    verifyWhatsappWebhookRequest(core, {
      "hub.mode": "subscribe",
      "hub.challenge": "123",
      "hub.verify_token": "raw token ",
    }),
    "123",
  );
});
test(
  "WhatsApp signed raw callbacks, retired pairing as text, human inbox transitions, media persistence, unsubscribe and campaign pricing",
  { skip: !process.env.CORE_WHATSAPP_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      schema = `wa_webhook_test_${randomUUID().replaceAll("-", "")}`,
      admin = new pg.Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
        connectionString: url,
        max: 2,
        options: `-c search_path=${schema} -c timezone=UTC`,
      }),
      requests: { path: string; body: any }[] = [],
      events: any[] = [];
    let base = "";
    const server = createServer(async (req, res) => {
      let bytes = "";
      for await (const chunk of req) bytes += chunk;
      const body = bytes ? JSON.parse(bytes) : null;
      requests.push({ path: req.url!, body });
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/waba/message_templates"))
        return res.end(
          JSON.stringify({
            data: [
              {
                id: "tpl",
                name: "hello",
                language: "en",
                status: "APPROVED",
                category: "MARKETING",
                components: [{ type: "BODY", text: "Hello" }],
              },
            ],
          }),
        );
      if (req.url === "/media") {
        return res.end(
          JSON.stringify({
            url: `${base}/media-bytes`,
            mime_type: "audio/ogg",
          }),
        );
      }
      if (req.url === "/media-bytes") {
        res.setHeader("content-type", "audio/ogg");
        return res.end(Buffer.from([1, 2, 3, 4]));
      }
      if (req.url === "/phone/messages")
        return res.end(JSON.stringify({ messages: [{ id: "reply-id" }] }));
      if (
        req.url === "/v1/channels/inbound" &&
        body.content.text === "force-fail"
      ) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: "local fixture rejected" }));
      }
      if (req.url?.includes("approvals"))
        return res.end(
          JSON.stringify({
            status: "approval_group_signalled",
            decision: "approved",
          }),
        );
      return res.end(JSON.stringify({ accepted: true }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const config = readConfig({
        DATABASE_URL: url,
        WHATSAPP_TOKEN_ENCRYPTION_KEY: "synthetic-key",
        AUTH_META_APP_SECRET: "synthetic-meta-key",
        WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify",
      }),
      core = { pool, config },
      options: WhatsappWebhookOptions = {
        config,
        graphBase: base,
        publishEvent: async (org, event) => {
          events.push({ org, event });
        },
        ingestCalls: async (_pool, _config, value) => {
          assert.equal(n.arr(n.obj(value).calls).length, 0);
        },
      };
    const app = Fastify();
    installErrorHandler(app);
    try {
      const tables = [
        "WhatsappConnection",
        "ExternalConnection",
        "Conversation",
        "Message",
        "MessageAttachment",
        "MessageReference",
        "MessageReaction",
        "MessageEvent",
        "Customer",
        "CustomerIdentity",
        "WhatsappContact",
        "WhatsappContactListMembership",
        "WhatsappTemplate",
        "WhatsappCampaign",
        "WhatsappCampaignRecipient",
        "WhatsappSendEvent",
      ];
      const columns = (
        await admin.query(
          `SELECT c.relname AS table_name,a.attname AS column_name,t.typname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_type t ON t.oid=a.atttypid WHERE n.nspname='public' AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped AND t.typtype='e'`,
          [tables],
        )
      ).rows;
      for (const type of new Set(columns.map((row) => row.typname))) {
        const labels = (
          await admin.query(
            `SELECT enumlabel FROM pg_enum JOIN pg_type t ON t.oid=enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typname=$1 ORDER BY enumsortorder`,
            [type],
          )
        ).rows;
        await pool.query(
          `CREATE TYPE "${type}" AS ENUM (${labels.map((row) => "'" + row.enumlabel.replaceAll("'", "''") + "'").join(",")})`,
        );
      }
      for (const table of tables)
        await pool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      for (const row of columns)
        await pool.query(
          `ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" DROP DEFAULT;ALTER TABLE "${row.table_name}" ALTER COLUMN "${row.column_name}" TYPE "${row.typname}" USING "${row.column_name}"::text::"${row.typname}"`,
        );
      await pool.query(
        readFileSync(
          "../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",
          "utf8",
        ),
      );
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","authMethod","updatedAt")VALUES('connection','user','org','phone',$1,'waba','GREEN','manual',NOW());`,
        [encryptSocialSecret(config, "synthetic-token")],
      );
      await pool.query(
        `INSERT INTO "ExternalConnection"(id,"orgId","sourceType","sourceId",provider,"displayName",status,"credentialStatus","healthStatus","webhookStatus","updatedAt")VALUES('workspace-channel','org','WHATSAPP','connection','whatsapp','Fixture','CONNECTED','VALID','HEALTHY','ACTIVE',NOW())`,
      );
      const incoming = (message: any) => ({
        metadata: { phone_number_id: "phone" },
        contacts: [{ wa_id: "27821234567", profile: { name: " Ada " } }],
        messages: [{ from: "27821234567", ...message }],
      });
      await handleIncomingMessages(
        pool,
        config,
        incoming({ id: "pairing", text: { body: "kasiai_pair_secret" } }),
        options,
      );
      assert.equal(
        (await pool.query('SELECT count(*) FROM "Message"')).rows[0].count,
        "1",
      );
      assert.equal(requests.length,0);
      await handleIncomingMessages(
        pool,
        config,
        incoming({ id: "inbound", text: { body: "hello" } }),
        options,
      );
      const conversation = (await pool.query('SELECT * FROM "Conversation"'))
          .rows[0],
        contact = (await pool.query('SELECT * FROM "WhatsappContact"')).rows[0];
      assert.equal(conversation.orgId, "org");
      assert.equal(conversation.unreadCount, 2);
      assert.equal(contact.customerId, conversation.customerId);
      assert.ok(requests.every(row=>!row.path.startsWith('/v1/')));
      assert.equal(
        events.find((row) => row.event.type === "message.created").event.message
          .canReact,
        true,
      );
      await pool.query(
        `INSERT INTO "Message"(id,"conversationId",sender,content,"contentType","whatsappMessageId","whatsappStatus",timestamp)VALUES('outbound',$1,'bot','reply','TEXT','wa-outbound','SENT',NOW())`,
        [conversation.id],
      );
      await handleStatus(
        pool,
        { id: "wa-outbound", status: "read", timestamp: "1780000000" },
        options,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT "whatsappStatus" FROM "Message" WHERE id='outbound'`,
          )
        ).rows[0].whatsappStatus,
        "READ",
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*) FROM "MessageEvent" WHERE kind='STATUS_READ'`,
          )
        ).rows[0].count,
        "1",
      );
      await handleIncomingMessages(
        pool,
        config,
        incoming({
          id: "media-inbound",
          audio: { id: "media", mime_type: "audio/ogg" },
        }),
        options,
      );
      const attachment=(await pool.query('SELECT * FROM "MessageAttachment" WHERE "providerMediaId"=$1',["media"])).rows[0];
      assert.ok(attachment);
      const beforeReplies = requests.filter(
        (row) => row.path === "/phone/messages",
      ).length;
      await handleIncomingMessages(
        pool,
        config,
        incoming({
          id: "pdf",
          document: { id: "pdf-media", mime_type: "application/pdf" },
        }),
        options,
      );
      assert.equal(
        requests.filter((row) => row.path === "/phone/messages").length,
        beforeReplies,
      );
      await handleIncomingMessages(
        pool,
        config,
        incoming({ id: "failure", text: { body: "force-fail" } }),
        options,
      );
      assert.equal(requests.filter(row=>row.path==='/phone/messages').length,beforeReplies);
      await pool.query(
        `UPDATE "WhatsappContact" SET "optIn"=true WHERE id=$1`,
        [contact.id],
      );
      await syncConnectionTemplates(pool, "user", "org", "connection", options);
      const template = (await pool.query('SELECT id FROM "WhatsappTemplate"'))
        .rows[0].id;
      const created = await createCampaign(
          pool,
          "user",
          "org",
          {
            name: "Fixture",
            connection_id: "connection",
            template_id: template,
            recipient_ids: [contact.id],
          },
          options,
        ),
        campaignId = created.campaign.id,
        recipient = (
          await pool.query(
            `SELECT id FROM "WhatsappCampaignRecipient" WHERE "campaignId"=$1`,
            [campaignId],
          )
        ).rows[0].id;
      await pool.query(
        `ALTER TABLE "WhatsappCampaignRecipient" ALTER COLUMN "sentAt" TYPE timestamp(6)`,
      );
      await pool.query(
        `UPDATE "WhatsappCampaignRecipient" SET status='SENT',"waMessageId"='campaign-message',"sentAt"='2026-01-01T00:00:00.123456Z' WHERE id=$1`,
        [recipient],
      );
      await handleStatus(
        pool,
        {
          id: "campaign-message",
          status: "delivered",
          timestamp: "1767225601",
          pricing: {
            billable: true,
            category: "marketing",
            pricing_model: "CBP",
          },
        },
        options,
      );
      const outbox = (
        await pool.query(
          `SELECT envelope FROM analytics_outbox WHERE contract_name='campaign.recipient.timing@1'`,
        )
      ).rows[0];
      assert.equal(outbox.envelope.data.duration_ms, 876);
      await handleStatus(
        pool,
        {
          id: "campaign-message",
          status: "failed",
          timestamp: "1767225602",
          errors: [{ code: 131026, message: "Recipient blocked" }],
        },
        options,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT status FROM "WhatsappCampaignRecipient" WHERE id=$1`,
            [recipient],
          )
        ).rows[0].status,
        "BLOCKED",
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*) FROM "WhatsappSendEvent" WHERE "recipientId"=$1`,
            [recipient],
          )
        ).rows[0].count,
        "1",
      );
      await pool.query(
        `UPDATE "WhatsappCampaignRecipient" SET status='QUEUED' WHERE id=$1`,
        [recipient],
      );
      await handleIncomingMessages(
        pool,
        config,
        incoming({ id: "stop", text: { body: "STOP" } }),
        options,
      );
      const updated = (
        await pool.query(
          `SELECT "optIn",excluded FROM "WhatsappContact" WHERE id=$1`,
          [contact.id],
        )
      ).rows[0];
      assert.equal(updated.optIn, false);
      assert.equal(updated.excluded, true);
      assert.equal(
        (
          await pool.query(
            `SELECT status FROM "WhatsappCampaignRecipient" WHERE id=$1`,
            [recipient],
          )
        ).rows[0].status,
        "UNSUBSCRIBED",
      );
      await registerWhatsappWebhookRoutes(app, core, options);
      assert.equal(
        (
          await app.inject({
            url: "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify&hub.challenge=123",
          })
        ).body,
        "123",
      );
      const raw = Buffer.from('{ "entry": [] }\n'),
        signature =
          "sha256=" +
          createHmac("sha256", "synthetic-meta-key").update(raw).digest("hex");
      const accepted = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
        },
        payload: raw,
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.deepEqual(accepted.json(), { success: true, queued: false });
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/webhooks/whatsapp",
            headers: {
              "content-type": "application/json",
              "x-hub-signature-256": signature,
            },
            payload: Buffer.from('{"entry":[]}'),
          })
        ).statusCode,
        403,
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
