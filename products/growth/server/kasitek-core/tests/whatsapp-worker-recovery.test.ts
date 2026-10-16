import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { installPgTimestampParsers } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import {
  createInboxDeliveryOptions,
  processSingleQueuedInboxMessage,
} from "../src/services/whatsapp/inbox-queue.js";

const database = process.env.CORE_WHATSAPP_RECOVERY_TEST_DATABASE_URL;
test(
  "native WhatsApp sender crash rolls back its claim and Analytics, allowing recovery with an ambiguous provider outcome",
  { skip: !database, timeout: 30000 },
  async () => {
    installPgTimestampParsers();
    const db = await isolatedDatabase(database!, "whatsapp_worker_recovery", [
      "WhatsappConnection",
      "ExternalConnection",
      "Conversation",
      "Message",
      "MessageAttachment",
      "MessageReference",
      "MessageReaction",
      "analytics_outbox",
    ]);
    const config = readConfig({
      DATABASE_URL: database!,
      SOCIAL_TOKEN_ENCRYPTION_KEY: "fixture-encryption",
    });
    const entered = Promise.withResolvers<void>();
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.equal(request.headers.authorization, "Bearer fixture-token");
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (requests.length === 1) {
        // The local provider has received/accepted the operation; deliberately lose its acknowledgement.
        entered.resolve();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ messages: [{ id: "provider-recovered" }] }),
      );
    });
    let child: ChildProcess | undefined;
    let childExit: Promise<[number | null, NodeJS.Signals | null]> | undefined;
    let childFailed = "";
    try {
      assert.match(
        (await db.pool.query("SHOW search_path")).rows[0].search_path,
        /^whatsapp_worker_recovery_[a-f0-9]+$/,
      );
      await db.pool.query(
        `INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","updatedAt")
      VALUES('wa','user','org','phone',$1,'waba','UNKNOWN',NOW())`,
        [encryptSocialSecret(config, "fixture-token")],
      );
      await db.pool
        .query(`INSERT INTO "Conversation"(id,channel,"customerIdentifier","orgId","updatedAt") VALUES('conversation','whatsapp','wa:wa:271234','org',NOW());
      INSERT INTO "Message"(id,"conversationId",sender,content,"whatsappStatus") VALUES('message','conversation','bot','Fixture reply','QUEUED')`);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address === "object");
      const providerUrl = `http://127.0.0.1:${address.port}/messages`;
      const scope = (await db.pool.query("SHOW search_path")).rows[0]
        .search_path as string;
      // A separate native process owns the actual SQL transaction and network request, not a mocked lock.
      child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      import pg from 'pg';
      import {readConfig} from './src/config.ts';
      import {createInboxDeliveryOptions,processSingleQueuedInboxMessage} from './src/services/whatsapp/inbox-queue.ts';
      const pool=new pg.Pool({connectionString:process.env.CORE_WHATSAPP_RECOVERY_TEST_DATABASE_URL, options:'-c search_path='+process.env.FIXTURE_SCHEMA+' -c timezone=UTC'});
      const config=readConfig({DATABASE_URL:process.env.CORE_WHATSAPP_RECOVERY_TEST_DATABASE_URL,SOCIAL_TOKEN_ENCRYPTION_KEY:'fixture-encryption'});
      const options=createInboxDeliveryOptions({pool,config},{fetch:(_url,init)=>fetch(process.env.FIXTURE_PROVIDER_URL,init)});
      try {await processSingleQueuedInboxMessage(pool,'message',options);} finally {await pool.end();}
    `,
        ],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
          env: {
            ...process.env,
            CORE_WHATSAPP_RECOVERY_TEST_DATABASE_URL: database!,
            FIXTURE_SCHEMA: scope,
            FIXTURE_PROVIDER_URL: providerUrl,
          },
        },
      );
      child.stderr!.on("data", (chunk) => {
        childFailed += String(chunk);
      });
      childExit = once(child, "exit") as Promise<
        [number | null, NodeJS.Signals | null]
      >;
      const first = await Promise.race([
        entered.promise.then(() => "provider"),
        childExit.then(() => "exit"),
      ]);
      assert.equal(first, "provider", childFailed);
      const options = createInboxDeliveryOptions(
        { pool: db.pool, config },
        { fetch: (_url, init) => fetch(providerUrl, init) },
      );
      assert.equal(
        await processSingleQueuedInboxMessage(db.pool, "message", options),
        false,
      );
      assert.equal(requests.length, 1);
      assert.equal(
        (
          await db.pool.query(
            'SELECT "whatsappStatus" FROM "Message" WHERE id=\'message\'',
          )
        ).rows[0].whatsappStatus,
        "QUEUED",
        "uncommitted PROCESSING is invisible to other connections",
      );
      assert(child.kill("SIGKILL"));
      const [code, signal] = await childExit;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      // Wait for PostgreSQL to observe the process disconnect and release its row lock.
      await db.pool.query("SET statement_timeout='5s'");
      await db.pool.query(
        "SELECT id FROM \"Message\" WHERE id='message' FOR UPDATE",
      );
      const rolledBack = (
        await db.pool.query(
          'SELECT "whatsappStatus","whatsappMessageId","errorMessage" FROM "Message" WHERE id=\'message\'',
        )
      ).rows[0];
      assert.deepEqual(rolledBack, {
        whatsappStatus: "QUEUED",
        whatsappMessageId: null,
        errorMessage: null,
      });
      assert.equal(
        (await db.pool.query("SELECT COUNT(*) FROM analytics_outbox")).rows[0]
          .count,
        "0",
      );
      assert.equal(
        await processSingleQueuedInboxMessage(db.pool, "message", options),
        true,
      );
      assert.equal(
        await processSingleQueuedInboxMessage(db.pool, "message", options),
        false,
      );
      assert.equal(requests.length, 2);
      assert.deepEqual(
        requests[0],
        requests[1],
        "source retry can repeat a provider-accepted operation whose acknowledgement was lost",
      );
      const recovered = (
        await db.pool.query(
          'SELECT "whatsappStatus","whatsappMessageId" FROM "Message" WHERE id=\'message\'',
        )
      ).rows[0];
      assert.deepEqual(recovered, {
        whatsappStatus: "SENT",
        whatsappMessageId: "provider-recovered",
      });
      assert.equal(
        (
          await db.pool.query(
            "SELECT COUNT(*) FROM analytics_outbox WHERE contract_name='conversation.message.lifecycle@1'",
          )
        ).rows[0].count,
        "1",
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      if (childExit) await childExit;
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);
