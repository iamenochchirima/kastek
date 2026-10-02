import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readConfig } from "../src-ts/config.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import {
  listInboxConversations,
  listConversationMessages,
  inboxUnreadCount,
  downloadMessageAttachment,
  previewText,
} from "../src-ts/services/whatsapp/inbox-read.js";
import {
  formatWhatsappText,
  extractMarkdownImages,
  validateAgentDeliveryIdempotencyKey,
  whatsappDeletedMessageResponderType,
  isProviderAuthenticationFailure,
} from "../src-ts/services/whatsapp/inbox-formatting.js";
import {
  uploadWhatsappMedia,
  sendMediaMessage,
  sendMediaLinkMessage,
  sendReactionMessage,
  markMessageReadApi,
  downloadMediaBytes,
  sendTextMessage,
  sendReplyButtonMessage,
} from "../src-ts/services/whatsapp/inbox-provider.js";

test("WhatsApp agent rendering preserves the existing Rust examples and UTF-8 delivery boundaries", () => {
  assert.equal(
    formatWhatsappText(
      "# Status\n\n- **Connections:** Ready\n- [ ] Review [the dashboard](https://example.com)\n\n> Check this\n\n| Account | State |\n| --- | --- |\n| KasiAI | Ready |",
    ),
    "*Status*\n\n• *Connections:* Ready\n☐ Review the dashboard: https://example.com\n\n│ Check this\n\n*Account:* KasiAI\n*State:* Ready",
  );
  assert.equal(
    formatWhatsappText(
      "Use `npm test`\n\n![Preview](https://example.com/image.png)\n\n```\nhello <world>\n```",
    ),
    "Use ```npm test```\n\n🖼️ Preview: https://example.com/image.png\n\n```\nhello <world>\n```",
  );
  assert.equal(
    formatWhatsappText("Marked ==text== and ||spoiler||."),
    "Marked text and spoiler.",
  );
  assert.equal(
    formatWhatsappText(
      "## Café ☕\r\n- [X] **完了**\r1) _done_\nfoo_bar_baz\n```js\nx",
    ),
    "*Café ☕*\n☑ *完了*\n1. _done_\nfoo_bar_baz\n```\nx\n```",
  );
  assert.deepEqual(
    extractMarkdownImages(
      "Please confirm:\n\n![announcement](https://core.test/media/asset-1)\n\nThanks",
    ),
    {
      text: "Please confirm:\n\nThanks",
      images: ["https://core.test/media/asset-1"],
    },
  );
  assert.equal(
    validateAgentDeliveryIdempotencyKey("  run-1:channel  "),
    "run-1:channel",
  );
  assert.throws(() => validateAgentDeliveryIdempotencyKey("é".repeat(121)));
  assert.throws(() => validateAgentDeliveryIdempotencyKey(" "));
  assert.equal(
    whatsappDeletedMessageResponderType("customer", {
      _kasitek_agent_idempotency_key: "run",
    }),
    "customer",
  );
  assert.equal(
    whatsappDeletedMessageResponderType("bot", {
      _kasitek_agent_idempotency_key: "run",
    }),
    "agent",
  );
  assert.equal(
    whatsappDeletedMessageResponderType("bot", {
      _kasitek_inbox_message_kind: "template",
    }),
    "system",
  );
  assert.equal(whatsappDeletedMessageResponderType("bot"), "human");
  assert.ok(
    isProviderAuthenticationFailure(
      "WhatsApp Cloud API text send failed (403 Forbidden): access denied",
    ),
  );
  assert.equal(
    isProviderAuthenticationFailure("400 Bad Request: Message undeliverable"),
    false,
  );
});

test("WhatsApp provider transport sends multipart and scoped media payloads and bounds chunked downloads", async () => {
  const requests: { path: string; body: string; type: string }[] = [];
  let base = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      path: req.url!,
      body: Buffer.concat(chunks).toString(),
      type: req.headers["content-type"] ?? "",
    });
    assert.equal(req.headers.authorization, "Bearer synthetic-token");
    if (req.url === "/v19.0/lookup") {
      res.end(JSON.stringify({ url: `${base}/bytes`, mime_type: "image/png" }));
      return;
    }
    if (req.url === "/v19.0/oversized") {
      res.end(JSON.stringify({ url: `${base}/chunked` }));
      return;
    }
    if (req.url === "/bytes") {
      res.end(Buffer.from([0, 1, 2, 255]));
      return;
    }
    if (req.url === "/chunked") {
      res.write(Buffer.from([0, 1, 2]));
      res.end(Buffer.from([3, 4, 5]));
      return;
    }
    const body = req.headers["content-type"]?.includes("application/json")
      ? JSON.parse(Buffer.concat(chunks).toString())
      : null;
    if (body?.to === "denied") {
      res.writeHead(403, "Forbidden");
      res.end(JSON.stringify({ error: { message: "access denied" } }));
      return;
    }
    if (body?.status === "read") {
      res.writeHead(204);
      res.end();
      return;
    }
    res.end(
      JSON.stringify(
        req.url?.endsWith("/media")
          ? { id: "media-1" }
          : { messages: [{ id: "message-1" }] },
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const options = {
    config: readConfig({ DATABASE_URL: "postgres://unused/unused" }),
    graphBase: `${base}/v19.0`,
  };
  try {
    const uploaded = await uploadWhatsappMedia(
      "phone",
      "synthetic-token",
      Buffer.from("fixture"),
      "hello.png",
      "image/png",
      options,
    );
    assert.equal(uploaded.mediaId, "media-1");
    assert.match(requests[0]!.type, /^multipart\/form-data; boundary=/);
    assert.match(requests[0]!.body, /filename="hello.png"/);
    assert.match(requests[0]!.body, /name="messaging_product"\r\n\r\nwhatsapp/);
    await assert.rejects(
      uploadWhatsappMedia(
        "phone",
        "synthetic-token",
        Buffer.alloc(0),
        "x",
        "not-a-mime",
        options,
      ),
      /mime type is invalid/,
    );
    assert.equal(
      (
        await sendMediaMessage(
          "phone",
          "synthetic-token",
          "recipient",
          "audio",
          "media-1",
          "ignored",
          "ignored",
          "reply-1",
          options,
        )
      ).messageId,
      "message-1",
    );
    assert.deepEqual(JSON.parse(requests[1]!.body), {
      messaging_product: "whatsapp",
      to: "recipient",
      type: "audio",
      audio: { id: "media-1" },
      context: { message_id: "reply-1" },
    });
    await sendMediaLinkMessage(
      "phone",
      "synthetic-token",
      "recipient",
      "https://fixture/image.png",
      null,
      null,
      options,
    );
    assert.equal(JSON.parse(requests[2]!.body).context, null);
    await sendReactionMessage(
      "phone",
      "synthetic-token",
      "recipient",
      "reply-1",
      "",
      options,
    );
    assert.deepEqual(JSON.parse(requests[3]!.body).reaction, {
      message_id: "reply-1",
      emoji: "",
    });
    await markMessageReadApi("phone", "synthetic-token", "reply-1", options);
    const download = await downloadMediaBytes(
      "synthetic-token",
      "lookup",
      4,
      options,
    );
    assert.deepEqual(download.bytes, Buffer.from([0, 1, 2, 255]));
    assert.equal(download.contentType, "image/png");
    await assert.rejects(
      downloadMediaBytes("synthetic-token", "lookup", 3, options),
      /exceeds the allowed size/,
    );
    await assert.rejects(
      downloadMediaBytes("synthetic-token", "oversized", 4, options),
      /exceeds the allowed size/,
    );
    await assert.rejects(
      sendReactionMessage(
        "phone",
        "synthetic-token",
        "denied",
        "reply-1",
        "👍",
        options,
      ),
      /403 Forbidden.*access denied/,
    );
    await sendTextMessage(
      "phone",
      "synthetic-token",
      "recipient",
      "hello",
      "reply-1",
      options,
    );
    assert.deepEqual(JSON.parse(requests.at(-1)!.body).text, { body: "hello" });
    await sendReplyButtonMessage(
      "phone",
      "synthetic-token",
      "recipient",
      "Approve?",
      [{ id: "approve", title: "👍".repeat(20) }],
      null,
      options,
    );
    assert.equal(
      JSON.parse(requests.at(-1)!.body).interactive.action.buttons[0].reply.id,
      "approve",
    );
    await assert.rejects(
      sendReplyButtonMessage(
        "phone",
        "synthetic-token",
        "recipient",
        "Approve?",
        [{ id: "approve", title: "👍".repeat(21) }],
        null,
        options,
      ),
      /labels are invalid/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test(
  "WhatsApp conversation reads preserve timeline capabilities and reject foreign workspace attachments",
  { skip: !process.env.CORE_WHATSAPP_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const fixture = await isolatedDatabase(
      process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
      "whatsapp_inbox_test",
      [
        "WhatsappConnection",
        "Conversation",
        "Message",
        "MessageAttachment",
        "MessageReference",
        "MessageReaction",
      ],
    );
    const { pool } = fixture;
    try {
      await pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","updatedAt") VALUES ('wa-1','user-1','org-1','phone-1','unused','waba','UNKNOWN',NOW())`,
      );
      await pool.query(
        `INSERT INTO "Conversation"(id,channel,"customerIdentifier","customerName","orgId","unreadCount","updatedAt") VALUES ('c1','whatsapp','wa:wa-1:27123','Café','org-1',2,NOW()),('foreign','whatsapp','wa:wa-1:27456','Other','org-2',8,NOW())`,
      );
      const text = "a".repeat(179) + "é";
      await pool.query(
        `INSERT INTO "Message"(id,"conversationId",sender,content,"providerMessageId") VALUES ('m1','c1','customer',$1,'provider-1'),('foreign-message','foreign','customer','secret','provider-2')`,
        [text],
      );
      await pool.query(
        `INSERT INTO "MessageAttachment"(id,"messageId",kind,"providerMediaId","createdAt","updatedAt") VALUES ('foreign-attachment','foreign-message','image','private-media',NOW(),NOW())`,
      );
      const conversations = (await listInboxConversations(pool, "org-1"))
        .conversations as Record<string, unknown>[];
      assert.equal(conversations.length, 1);
      assert.equal(conversations[0]!.lastMessage, "a".repeat(179) + "...");
      assert.equal(conversations[0]!.connectionLabel, "phone-1");
      assert.equal(previewText("Café", 4), "Caf...");
      assert.deepEqual(await inboxUnreadCount(pool, "org-1"), {
        unreadCount: 2n,
      });
      const timeline = await listConversationMessages(pool, "org-1", "c1");
      assert.equal(
        (timeline.messages as Record<string, unknown>[])[0]!.canReact,
        true,
      );
      assert.equal(
        (timeline.capabilities as Record<string, unknown>).reaction,
        true,
      );
      await assert.rejects(
        listConversationMessages(pool, "org-1", "foreign"),
        /Conversation not found/,
      );
      await assert.rejects(
        downloadMessageAttachment(
          pool,
          "org-1",
          "foreign-message",
          "foreign-attachment",
          {
            config: readConfig({
              DATABASE_URL: process.env.CORE_WHATSAPP_TEST_DATABASE_URL!,
            }),
            fetch: (async () => {
              throw Error("Foreign attachment reached provider");
            }) as typeof fetch,
          },
        ),
        /Media message not found/,
      );
    } finally {
      await fixture.close();
    }
  },
);
