import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { readConfig } from "../src-ts/config.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import { buildApp } from "../src-ts/app.js";
import { encryptSocialSecret } from "../src-ts/integrations/crypto.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { startInboxConversation } from "../src-ts/services/whatsapp/inbox-start.js";
import { createInboxDeliveryOptions } from "../src-ts/services/whatsapp/inbox-queue.js";
import { registerWhatsappInboxRoutes } from "../src-ts/routes/whatsapp-inbox.js";

test("Dedicated WhatsApp inbox routes enforce authentication and strict JSON field types", async () => {
  const config = readConfig({
      DATABASE_URL: "postgres://unused:unused@127.0.0.1:9/unused",
      LOG_LEVEL: "silent",
    }),
    pool = new pg.Pool({ connectionString: config.databaseUrl });
  const app = await buildApp({ config, pool }, [registerWhatsappInboxRoutes]);
  try {
    for (const [method, url, payload] of [
      ["GET", "conversations", undefined],
      ["POST", "conversations", {}],
      ["GET", "unread-count", undefined],
      ["GET", "fixture/messages", undefined],
      ["PATCH", "fixture", {}],
      ["DELETE", "fixture", undefined],
      ["POST", "fixture/messages", {}],
      ["POST", "fixture/read", undefined],
      ["POST", "fixture/messages/message/reaction", {}],
      ["DELETE", "fixture/messages/message", undefined],
      ["GET", "media/message/attachments/attachment", undefined],
    ] as const) {
      const response = await app.inject({
        method,
        url: "/api/whatsapp/inbox/" + url,
        ...(payload === undefined ? {} : { payload }),
      });
      assert.equal(response.statusCode, 401, url);
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/whatsapp/inbox/conversations",
          payload: { bodyParameters: [1] },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/whatsapp/inbox/fixture",
          payload: { starred: "false" },
        })
      ).statusCode,
      400,
    );
    const media = await app.inject({
      method: "POST",
      url: "/api/whatsapp/inbox/fixture/messages/media",
      headers: { "content-type": "multipart/form-data; boundary=fixture" },
      payload: "--fixture--\r\n",
    });
    assert.equal(media.statusCode, 401);
  } finally {
    await app.close();
    await pool.end();
  }
});

test(
  "Approved template starts link customer/contact and publish the local message ID",
  { skip: !process.env.CORE_WHATSAPP_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const fixture = await isolatedDatabase(
      process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      "whatsapp_start_test",
      [
        "WhatsappConnection",
        "WhatsappTemplate",
        "WhatsappContact",
        "ExternalConnection",
        "Conversation",
        "Message",
        "MessageAttachment",
        "MessageReference",
        "MessageReaction",
        "Customer",
        "CustomerIdentity",
        "analytics_outbox",
      ],
    );
    const { pool } = fixture,
      config = readConfig({
        DATABASE_URL: process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
        SOCIAL_TOKEN_ENCRYPTION_KEY: "synthetic-key",
      }),
      context = { pool, config };
    const sent: Record<string, any>[] = [],
      published: string[] = [];
    const options = createInboxDeliveryOptions(context, {
      fetch: (async (_url, init) => {
        sent.push(JSON.parse(init!.body as string));
        return new Response(
          JSON.stringify({ messages: [{ id: "provider-" + sent.length }] }),
        );
      }) as typeof fetch,
    });
    options.events.publishMessageCreated = async (_pool, _user, id) => {
      published.push(id);
    };
    try {
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","updatedAt") VALUES ('wa','user','org','phone',$1,'waba','UNKNOWN',NOW())`,
        [encryptSocialSecret(config, "synthetic-token")],
      );
      await pool.query(
        `INSERT INTO "ExternalConnection"(id,"orgId",provider,"sourceType","sourceId","displayName",status,"updatedAt") VALUES ('ext','org','WHATSAPP','WHATSAPP','wa','Fixture','CONNECTED',NOW())`,
      );
      await pool.query(
        `INSERT INTO "WhatsappTemplate"(id,"userId","orgId","connectionId","templateName",language,category,body,"variablesCount",status,"updatedAt") VALUES ('template','user','org','wa','hello','en','UTILITY','Hello {{1}}',1,'APPROVED',NOW()),('foreign-template','user','other','wa','other','en','UTILITY','Other',0,'APPROVED',NOW())`,
      );
      const input = {
        connectionId: "wa",
        templateId: "template",
        phone: "+27 71 234 5678",
        customerName: "Ada",
        bodyParameters: ["Ada"],
      };
      await assert.rejects(
        startInboxConversation(
          context,
          "user",
          "org",
          { ...input, bodyParameters: [] },
          options,
        ),
        /expects 1 variable/,
      );
      await assert.rejects(
        startInboxConversation(
          context,
          "user",
          "org",
          { ...input, templateId: "foreign-template" },
          options,
        ),
        /Approved template not found/,
      );
      const result = await startInboxConversation(
        context,
        "user",
        "org",
        input,
        options,
      );
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, "+27712345678");
      assert.deepEqual(sent[0]!.template.components, [
        { type: "body", parameters: [{ type: "text", text: "Ada" }] },
      ]);
      const message = (
        await pool.query(
          `SELECT id,content,"providerMetadata","whatsappMessageId" FROM "Message" WHERE "conversationId"=$1`,
          [result.conversationId],
        )
      ).rows[0];
      assert.equal(result.messageId, "provider-1");
      assert.deepEqual(published, [message.id]);
      assert.equal(message.content, "Hello {{1}}");
      assert.deepEqual(message.providerMetadata, {
        _kasitek_inbox_message_kind: "template",
      });
      const contact = (
        await pool.query(
          `SELECT "customerId","optIn",phone FROM "WhatsappContact" WHERE id=$1`,
          [result.contactId],
        )
      ).rows[0];
      assert.ok(contact.customerId);
      assert.equal(contact.optIn, false);
      assert.equal(contact.phone, "+27712345678");
      assert.equal(
        (
          await pool.query(
            `SELECT "customerId" FROM "Conversation" WHERE id=$1`,
            [result.conversationId],
          )
        ).rows[0].customerId,
        contact.customerId,
      );
      const repeated = await startInboxConversation(
        context,
        "user",
        "org",
        input,
        options,
      );
      assert.equal(repeated.conversationId, result.conversationId);
      assert.equal(repeated.contactId, result.contactId);
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS count FROM analytics_outbox`,
          )
        ).rows[0].count,
        3,
      );
    } finally {
      await fixture.close();
    }
  },
);
