import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src-ts/config.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import { encryptSocialSecret } from "../src-ts/integrations/crypto.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import {
  createInboxDeliveryOptions,
  processSingleQueuedInboxMessage,
  processQueuedInboxMessages,
} from "../src-ts/services/whatsapp/inbox-queue.js";
import {
  sendConversationMessage,
  markConversationRead,
  updateConversation,
  deleteConversation,
} from "../src-ts/services/whatsapp/inbox-mutations.js";
import { runWhatsappInbox } from "../src-ts/workers/whatsapp-inbox.js";

test(
  "WhatsApp queued replies, worker locking, provider failure and local read state persist with Analytics",
  { skip: !process.env.CORE_WHATSAPP_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const fixture = await isolatedDatabase(
      process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      "whatsapp_delivery_test",
      [
        "WhatsappConnection",
        "ExternalConnection",
        "Conversation",
        "Message",
        "MessageAttachment",
        "MessageReference",
        "MessageReaction",
        "analytics_outbox",
      ],
    );
    const { pool } = fixture;
    const config = readConfig({
      DATABASE_URL: process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      SOCIAL_TOKEN_ENCRYPTION_KEY: "synthetic-key",
    });
    const context = { pool, config };
    const calls: Record<string, unknown>[] = [];
    let release: (() => void) | null = null;
    let entered: (() => void) | null = null;
    const deliveryEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const deliveryBlocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let block = true;
    const options = createInboxDeliveryOptions(context, {
      fetch: (async (_url, init) => {
        assert.equal(
          (init!.headers as Record<string, string>).authorization,
          "Bearer synthetic-token",
        );
        const body = JSON.parse(init!.body as string);
        calls.push(body);
        if (body.status === "read")
          return new Response("receipt unavailable", { status: 503 });
        if (block) {
          block = false;
          entered!();
          await deliveryBlocked;
        }
        return body.text.body === "fail"
          ? new Response(
              JSON.stringify({ error: { message: "Message undeliverable" } }),
              { status: 400, statusText: "Bad Request" },
            )
          : new Response(
              JSON.stringify({ messages: [{ id: "sent-" + calls.length }] }),
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
        `INSERT INTO "Conversation"(id,channel,"customerIdentifier","orgId","unreadCount","updatedAt") VALUES ('c1','whatsapp','wa:wa-1:27123','org-1',2,NOW())`,
      );
      await pool.query(
        `INSERT INTO "Message"(id,"conversationId",sender,content,"whatsappMessageId") VALUES ('incoming','c1','customer','question','provider-incoming')`,
      );
      await assert.rejects(
        sendConversationMessage(
          context,
          "user-1",
          "org-other",
          "c1",
          { text: "forbidden" },
          options,
        ),
        /Conversation not found/,
      );
      const queued = await sendConversationMessage(
        context,
        "user-1",
        "org-1",
        "c1",
        { text: "  reply  ", replyToMessageId: "incoming" },
        options,
      );
      const id = queued.messageId as string;
      assert.equal(
        (
          await pool.query(
            `SELECT "referencedProviderMessageId" FROM "MessageReference" WHERE "messageId"=$1`,
            [id],
          )
        ).rows[0].referencedProviderMessageId,
        "provider-incoming",
      );
      const first = processSingleQueuedInboxMessage(pool, id, options);
      await deliveryEntered;
      assert.equal(
        await processSingleQueuedInboxMessage(pool, id, options),
        false,
      );
      release!();
      assert.equal(await first, true);
      assert.equal(
        await processSingleQueuedInboxMessage(pool, id, options),
        false,
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.context, { message_id: "provider-incoming" });
      assert.equal(
        (
          await pool.query(
            `SELECT "whatsappStatus" FROM "Message" WHERE id=$1`,
            [id],
          )
        ).rows[0].whatsappStatus,
        "SENT",
      );
      const failure = await sendConversationMessage(
        context,
        "user-1",
        "org-1",
        "c1",
        { text: "fail" },
        options,
      );
      assert.equal(await processQueuedInboxMessages(context, 10, options), 1);
      const failed = (
        await pool.query(
          `SELECT "whatsappStatus","errorCode","errorMessage" FROM "Message" WHERE id=$1`,
          [failure.messageId],
        )
      ).rows[0];
      assert.equal(failed.whatsappStatus, "FAILED");
      assert.equal(failed.errorCode, "SEND_FAILED");
      assert.match(
        failed.errorMessage,
        /400 Bad Request.*Message undeliverable/,
      );
      assert.equal(await processQueuedInboxMessages(context, 10, options), 0);
      await pool.query(
        `INSERT INTO "Conversation"(id,channel,"customerIdentifier","orgId","updatedAt") VALUES ('foreign','whatsapp','wa:wa-1:27456','org-other',NOW())`,
      );
      await pool.query(
        `INSERT INTO "Message"(id,"conversationId",sender,content,"whatsappStatus") VALUES ('foreign-queued','foreign','bot','must not send','QUEUED')`,
      );
      assert.equal(
        await processSingleQueuedInboxMessage(pool, "foreign-queued", options),
        false,
      );
      await pool.query(
        `DELETE FROM "Message" WHERE id='foreign-queued'; DELETE FROM "Conversation" WHERE id='foreign'`,
      );
      await markConversationRead(context, "user-1", "org-1", "c1", options);
      assert.equal(
        (
          await pool.query(
            `SELECT "unreadCount" FROM "Conversation" WHERE id='c1'`,
          )
        ).rows[0].unreadCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT "whatsappStatus" FROM "Message" WHERE id='incoming'`,
          )
        ).rows[0].whatsappStatus,
        "READ",
      );
      assert.deepEqual(
        await updateConversation(
          context,
          "user-1",
          "org-1",
          "c1",
          { starred: true },
          options,
        ),
        { success: true, conversationId: "c1", starred: true },
      );
      const controller = new AbortController();
      controller.abort();
      await runWhatsappInbox(
        context,
        {
          info() {},
          error() {
            throw Error("Stopped worker ran");
          },
        },
        controller.signal,
        options,
      );
      const outbox = (
        await pool.query(`SELECT COUNT(*)::int AS count FROM analytics_outbox`)
      ).rows[0].count;
      assert.equal(outbox, 4);
      await deleteConversation(context, "org-1", "c1");
      assert.equal(
        (await pool.query(`SELECT COUNT(*)::int AS count FROM "Message"`))
          .rows[0].count,
        0,
      );
      assert.equal(
        (
          await pool.query(
            `SELECT COUNT(*)::int AS count FROM analytics_outbox`,
          )
        ).rows[0].count,
        5,
      );
    } finally {
      release?.();
      await fixture.close();
    }
  },
);
