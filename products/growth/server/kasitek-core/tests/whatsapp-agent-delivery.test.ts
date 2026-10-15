import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { deliverAgentMessage } from "../src/services/whatsapp/inbox-agent.js";
import { createInboxDeliveryOptions } from "../src/services/whatsapp/inbox-queue.js";
import {
  sendConversationMedia,
  readWhatsappMultipart,
} from "../src/services/whatsapp/inbox-media.js";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import {
  sendMessageReaction,
  deleteConversationMessage,
} from "../src/services/whatsapp/inbox-messages.js";

test(
  "Agent WhatsApp delivery preserves durable replay, concurrent claims, captions, failures and partial-send uncertainty",
  { skip: !process.env.CORE_WHATSAPP_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const fixture = await isolatedDatabase(
      process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      "whatsapp_agent_test",
      [
        "WhatsappConnection",
        "ExternalConnection",
        "Conversation",
        "Message",
        "MessageAttachment",
        "MessageReference",
        "MessageReaction",
        "MessageEvent",
        "analytics_outbox",
      ],
    );
    const { pool } = fixture,
      config = readConfig({
        DATABASE_URL: process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
        SOCIAL_TOKEN_ENCRYPTION_KEY: "synthetic-key",
      }),
      context = { pool, config };
    const calls: Record<string, any>[] = [];
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    let block = true,
      failText = true,
      failImage = false;
    const options = createInboxDeliveryOptions(context, {
      fetch: (async (_url, init) => {
        if (init!.body instanceof FormData) {
          assert.equal(init!.body.get("messaging_product"), "whatsapp");
          const file = init!.body.get("file") as File;
          assert.equal(file.name, "fixture.png");
          assert.equal(file.type, "image/png");
          assert.equal(await file.text(), "fixture");
          return new Response(
            JSON.stringify({
              id: "uploaded-media",
              sha256: "synthetic-checksum",
            }),
          );
        }
        const body = JSON.parse(init!.body as string);
        calls.push(body);
        if (block) {
          block = false;
          entered!();
          await gate;
        }
        if (
          (body.text?.body === "fail" && failText) ||
          (body.image?.link?.endsWith("/second") && failImage)
        )
          return new Response(
            JSON.stringify({ error: { message: "Message undeliverable" } }),
            { status: 400, statusText: "Bad Request" },
          );
        return new Response(
          JSON.stringify({ messages: [{ id: "provider-" + calls.length }] }),
        );
      }) as typeof fetch,
    });
    try {
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","updatedAt") VALUES ('wa-1','user-1','org-1','phone-1',$1,'waba','UNKNOWN',NOW())`,
        [encryptSocialSecret(config, "synthetic-token")],
      );
      await pool.query(
        `INSERT INTO "ExternalConnection"(id,"orgId",provider,"sourceType","sourceId","displayName",status,"updatedAt") VALUES ('ext','org-1','WHATSAPP','WHATSAPP','wa-1','Fixture','CONNECTED',NOW())`,
      );
      await pool.query(
        `INSERT INTO "Conversation"(id,channel,"customerIdentifier","orgId","updatedAt") VALUES ('c1','whatsapp','wa:wa-1:27123','org-1',NOW())`,
      );
      await assert.rejects(
        deliverAgentMessage(
          context,
          "other-org",
          "c1",
          "test",
          "bad-org",
          [],
          [],
          options,
        ),
        /conversation not found/,
      );
      const first = deliverAgentMessage(
        context,
        "org-1",
        "c1",
        "**hello**",
        "same-key",
        [],
        [],
        options,
      );
      await started;
      const concurrent = await deliverAgentMessage(
        context,
        "org-1",
        "c1",
        "**hello**",
        "same-key",
        [],
        [],
        options,
      );
      assert.deepEqual(concurrent, {
        status: "unknown",
        idempotentReplay: true,
        providerStatus: "SENDING",
      });
      release!();
      assert.deepEqual(await first, {
        providerMessageId: "provider-1",
        status: "sent",
      });
      assert.deepEqual(
        await deliverAgentMessage(
          context,
          "org-1",
          "c1",
          "**hello**",
          "same-key",
          [],
          [],
          options,
        ),
        {
          providerMessageId: "provider-1",
          status: "sent",
          idempotentReplay: true,
        },
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.text.body, "*hello*");
      await assert.rejects(
        deliverAgentMessage(
          context,
          "org-1",
          "c1",
          "fail",
          "retry-key",
          [],
          [],
          options,
        ),
        /Message undeliverable/,
      );
      const failure = (
        await pool.query(
          `SELECT "errorCode","whatsappStatus" FROM "Message" WHERE "providerMetadata"->>'_kasitek_agent_idempotency_key'='retry-key'`,
        )
      ).rows[0];
      assert.equal(failure.errorCode, "AGENT_DELIVERY_FAILED");
      assert.equal(failure.whatsappStatus, "FAILED");
      failText = false;
      assert.equal(
        (
          await deliverAgentMessage(
            context,
            "org-1",
            "c1",
            "fail",
            "retry-key",
            [],
            [],
            options,
          )
        ).status,
        "sent",
      );
      await deliverAgentMessage(
        context,
        "org-1",
        "c1",
        "Caption\n![a](https://fixture/first)",
        "image-key",
        [],
        [],
        options,
      );
      assert.deepEqual(calls.at(-1)!.image, {
        link: "https://fixture/first",
        caption: "Caption",
      });
      await deliverAgentMessage(
        context,
        "org-1",
        "c1",
        "Approve",
        "button-key",
        [],
        [{ id: "approve", title: "Approve" }],
        options,
      );
      assert.equal(
        calls.at(-1)!.interactive.action.buttons[0].reply.id,
        "approve",
      );
      failImage = true;
      const partial =
        "Images\n![a](https://fixture/first)\n![b](https://fixture/second)";
      await assert.rejects(
        deliverAgentMessage(
          context,
          "org-1",
          "c1",
          partial,
          "partial-key",
          [],
          [],
          options,
        ),
        /Message undeliverable/,
      );
      const before = calls.length;
      assert.deepEqual(
        await deliverAgentMessage(
          context,
          "org-1",
          "c1",
          partial,
          "partial-key",
          [],
          [],
          options,
        ),
        {
          status: "unknown",
          idempotentReplay: true,
          providerStatus: "SENDING",
        },
      );
      assert.equal(calls.length, before);
      const metadata = (
        await pool.query(
          `SELECT "providerMetadata" FROM "Message" WHERE "providerMetadata"->>'_kasitek_agent_idempotency_key'='same-key'`,
        )
      ).rows[0].providerMetadata;
      assert.deepEqual(metadata, {
        _kasitek_agent_idempotency_key: "same-key",
        _kasitek_agent_media: [],
      });
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS count FROM "Message" WHERE "providerMetadata"->>'_kasitek_agent_idempotency_key'='same-key'`,
          )
        ).rows[0].count,
        1,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS count FROM analytics_outbox`,
          )
        ).rows[0].count,
        11,
      );
      await pool.query(
        `INSERT INTO "Message"(id,"conversationId",sender,content,"whatsappMessageId") VALUES ('incoming','c1','customer','question','incoming-provider')`,
      );
      const delivered = await sendConversationMedia(
        context,
        "user-1",
        "org-1",
        "c1",
        {
          bytes: Buffer.from("fixture"),
          filename: "fixture.png",
          mimeType: "image/png",
          caption: "Caption",
          replyToMessageId: "incoming",
        },
        options,
      );
      assert.equal(delivered.status, "SENT");
      assert.deepEqual(calls.at(-1)!.image, {
        id: "uploaded-media",
        caption: "Caption",
      });
      assert.deepEqual(calls.at(-1)!.context, {
        message_id: "incoming-provider",
      });
      const attachment = (
        await pool.query(
          `SELECT "providerMediaId",checksum,"fileName" FROM "MessageAttachment" WHERE "messageId"=$1`,
          [delivered.messageId],
        )
      ).rows[0];
      assert.deepEqual(attachment, {
        providerMediaId: "uploaded-media",
        checksum: "synthetic-checksum",
        fileName: "fixture.png",
      });
      assert.equal(
        (
          await pool.query(
            `SELECT "referencedProviderMessageId" FROM "MessageReference" WHERE "messageId"=$1`,
            [delivered.messageId],
          )
        ).rows[0].referencedProviderMessageId,
        "incoming-provider",
      );
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS count FROM analytics_outbox`,
          )
        ).rows[0].count,
        12,
      );
      await sendMessageReaction(
        context,
        "org-1",
        "c1",
        "incoming",
        { emoji: " 👍 " },
        options,
      );
      assert.deepEqual(calls.at(-1)!.reaction, {
        message_id: "incoming-provider",
        emoji: "👍",
      });
      assert.equal(
        (
          await pool.query(
            `SELECT active FROM "MessageReaction" WHERE "messageId"='incoming'`,
          )
        ).rows[0].active,
        true,
      );
      await sendMessageReaction(
        context,
        "org-1",
        "c1",
        "incoming",
        { remove: true },
        options,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT active FROM "MessageReaction" WHERE "messageId"='incoming'`,
          )
        ).rows[0].active,
        false,
      );
      await pool.query(
        `ALTER TABLE "Message" ALTER COLUMN timestamp TYPE timestamp(6); ALTER TABLE "Conversation" ALTER COLUMN "lastMessageAt" TYPE timestamp(6); UPDATE "Message" SET timestamp='2030-01-01T00:00:00.123456Z' WHERE id='incoming'`,
      );
      await deleteConversationMessage(
        context,
        "org-1",
        "c1",
        delivered.messageId as string,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT "lastMessageAt" FROM "Conversation" WHERE id='c1'`,
          )
        ).rows[0].lastMessageAt.toISOString(),
        "2030-01-01T00:00:00.123456Z",
      );
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS count FROM analytics_outbox`,
          )
        ).rows[0].count,
        13,
      );
    } finally {
      release?.();
      await fixture.close();
    }
  },
);

test("WhatsApp multipart parser preserves binary files beyond the unrelated logo limit", async () => {
  const app = Fastify();
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  app.post("/fixture", async (request) => {
    const upload = await readWhatsappMultipart(request);
    return {
      size: upload.bytes.byteLength,
      filename: upload.filename,
      mimeType: upload.mimeType,
      caption: upload.caption,
      reply: upload.replyToMessageId,
    };
  });
  const boundary = "fixture-boundary",
    binary = Buffer.alloc(6 * 1024 * 1024, 0xff);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n Caption \r\n--${boundary}\r\nContent-Disposition: form-data; name="replyToMessageId"\r\n\r\n incoming \r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="hello world.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    binary,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/fixture",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      size: binary.length,
      filename: "hello_world.png",
      mimeType: "image/png",
      caption: "Caption",
      reply: "incoming",
    });
  } finally {
    await app.close();
  }
});
