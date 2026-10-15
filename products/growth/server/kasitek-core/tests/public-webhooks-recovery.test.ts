import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import {
  createSubscription,
  enqueueDomainEvent,
  listDeliveries,
  listSubscriptions,
  processDueDeliveries,
  retryDelay,
  webhookSignature,
} from "../src/services/public-webhooks.js";
const database = process.env.CORE_WEBHOOK_RECOVERY_TEST_DATABASE_URL;
async function fixture() {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "webhook_recovery", [
    "PublicApiWebhookSubscription",
    "PublicApiWebhookDelivery",
  ]);
  const received: { event: string; body: Buffer }[] = [],
    secret = "s".repeat(32);
  let status = 503,
    hold: Promise<void> | undefined,
    entered: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    assert.equal(
      request.headers["x-kasitek-webhook-signature"],
      webhookSignature(
        secret,
        Number(request.headers["x-kasitek-webhook-timestamp"]),
        body,
      ),
    );
    received.push({
      event: String(request.headers["x-kasitek-webhook-id"]),
      body,
    });
    entered?.();
    await hold;
    response.writeHead(status);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const config = readConfig({
    DATABASE_URL: database!,
    PUBLIC_WEBHOOK_ENCRYPTION_KEY: "synthetic-encryption-key",
  });
  const subscription = await createSubscription(
    db.pool,
    "org",
    {
      url: `http://localhost:${address.port}/events`,
      secret,
      eventTypes: ["content.post.created"],
    },
    config,
    "fixture",
  );
  const id = String(subscription.subscription.id);
  return {
    ...db,
    config,
    received,
    id,
    setStatus(value: number) {
      status = value;
    },
    pause() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      const waiting = new Promise<void>((resolve) => (entered = resolve));
      return { waiting, release };
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}
test(
  "Webhook retries persist bounded backoff and disable subscription at ten failed attempts",
  { skip: !database },
  async () => {
    const f = await fixture();
    try {
      await enqueueDomainEvent(f.pool, "org", "content.post.created", {
        postId: "exhausted",
        title: "Synthetic",
      });
      const original = (await listDeliveries(f.pool, "org", f.id))[0]!;
      let firstBody: Buffer | undefined;
      for (let attempt = 1; attempt <= 10; attempt++) {
        await f.pool.query(
          'UPDATE "PublicApiWebhookDelivery" SET "nextAttemptAt"=NOW()-INTERVAL \'1 second\' WHERE id=$1',
          [original.id],
        );
        assert.equal(await processDueDeliveries(f.pool, f.config, 1), 1);
        const state = (await listDeliveries(f.pool, "org", f.id))[0]!,
          subscription = (await listSubscriptions(f.pool, "org"))[0]!;
        assert.equal(state.attemptCount, attempt);
        assert.equal(state.status, attempt === 10 ? "FAILED" : "PENDING");
        assert.equal(state.lastStatusCode, 503);
        assert.equal(state.lastError, "Webhook endpoint returned HTTP 503");
        assert.equal(state.deliveredAt, null);
        const delay = (
          await f.pool.query(
            `SELECT EXTRACT(EPOCH FROM ("nextAttemptAt"-"updatedAt")) AS delay FROM "PublicApiWebhookDelivery" WHERE id=$1`,
            [original.id],
          )
        ).rows[0].delay;
        assert(Math.abs(Number(delay) - retryDelay(attempt)) < 0.01);
        assert.equal(subscription.failureCount, attempt);
        assert(subscription.lastFailureAt);
        assert.equal(
          subscription.status,
          attempt === 10 ? "DISABLED" : "ACTIVE",
        );
        assert.equal(
          subscription.disabledReason,
          attempt === 10 ? "delivery_attempt_limit" : null,
        );
        const sent = f.received.at(-1)!;
        assert.equal(sent.event, "content.post.created:exhausted");
        if (firstBody) assert.deepEqual(sent.body, firstBody);
        else firstBody = sent.body;
      }
      assert.equal(f.received.length, 10);
      await f.pool.query(
        `UPDATE "PublicApiWebhookDelivery" SET "nextAttemptAt"=NOW()-INTERVAL '1 second'`,
      );
      assert.equal(await processDueDeliveries(f.pool, f.config, 100), 0);
      // A different pending event on a disabled subscription is retained, never sent.
      await f.pool.query(
        `INSERT INTO "PublicApiWebhookDelivery"(id,"subscriptionId","eventId","eventType",payload,status,"updatedAt")VALUES('blocked',$1,'blocked','content.post.created','{}','PENDING',NOW())`,
        [f.id],
      );
      assert.equal(await processDueDeliveries(f.pool, f.config, 1), 0);
      assert.equal(f.received.length, 10);
      assert.equal(
        (
          await f.pool.query(
            `SELECT status FROM "PublicApiWebhookDelivery" WHERE id='blocked'`,
          )
        ).rows[0].status,
        "PENDING",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "Webhook crash recovery only reclaims an expired lease; competing workers preserve one active delivery",
  { skip: !database },
  async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    try {
      f.setStatus(204);
      await enqueueDomainEvent(f.pool, "org", "content.post.created", {
        postId: "recovered",
      });
      const job = (await listDeliveries(f.pool, "org", f.id))[0]!;
      await f.pool.query(
        `UPDATE "PublicApiWebhookDelivery" SET status='DELIVERING',"attemptCount"=3,"updatedAt"=NOW()-INTERVAL '4 minutes' WHERE id=$1`,
        [job.id],
      );
      await f.pool.query(
        `UPDATE "PublicApiWebhookSubscription" SET "failureCount"=7 WHERE id=$1`,
        [f.id],
      );
      assert.equal(await processDueDeliveries(f.pool, f.config, 1), 0);
      assert.equal(f.received.length, 0);
      await f.pool.query(
        `UPDATE "PublicApiWebhookDelivery" SET "updatedAt"=NOW()-INTERVAL '6 minutes' WHERE id=$1`,
        [job.id],
      );
      const paused = f.pause();
      release = paused.release;
      const first = processDueDeliveries(f.pool, f.config, 1);
      await paused.waiting;
      const claimed = (await listDeliveries(f.pool, "org", f.id))[0]!;
      assert.equal(claimed.status, "DELIVERING");
      assert.equal(claimed.attemptCount, 4);
      const competing = await Promise.all(
        Array.from({ length: 12 }, () =>
          processDueDeliveries(f.pool, f.config, 1),
        ),
      );
      assert(competing.every((result) => result === 0));
      assert.equal(f.received.length, 1);
      release();
      await first;
      release = undefined;
      const delivered = (await listDeliveries(f.pool, "org", f.id))[0]!;
      assert.equal(delivered.status, "DELIVERED");
      assert.equal(delivered.attemptCount, 4);
      assert.equal(delivered.lastStatusCode, 204);
      assert.equal(delivered.lastError, null);
      assert(delivered.deliveredAt);
      const subscription = (await listSubscriptions(f.pool, "org"))[0]!;
      assert.equal(subscription.failureCount, 0);
      assert(subscription.lastDeliveredAt);
      assert.equal(subscription.status, "ACTIVE");
      assert.equal(await processDueDeliveries(f.pool, f.config, 1), 0);
      assert.equal(f.received[0]!.event, "content.post.created:recovered");
    } finally {
      release?.();
      await f.close();
    }
  },
);

test(
  "Webhook shutdown abort leaves an in-flight claim for lease recovery without counting a failure",
  { skip: !database },
  async () => {
    const f = await fixture();
    let release: (() => void) | undefined;
    try {
      f.setStatus(204);
      await enqueueDomainEvent(f.pool, "org", "content.post.created", {
        postId: "shutdown",
      });
      const job = (await listDeliveries(f.pool, "org", f.id))[0]!,
        paused = f.pause(),
        controller = new AbortController();
      release = paused.release;
      const inFlight = processDueDeliveries(
        f.pool,
        f.config,
        1,
        controller.signal,
      );
      await paused.waiting;
      controller.abort();
      assert.equal(await inFlight, 0);
      const interrupted = (await listDeliveries(f.pool, "org", f.id))[0]!,
        afterInterrupt = (await listSubscriptions(f.pool, "org"))[0]!;
      assert.equal(interrupted.status, "DELIVERING");
      assert.equal(interrupted.attemptCount, 1);
      assert.equal(interrupted.lastStatusCode, null);
      assert.equal(interrupted.lastError, null);
      assert.equal(afterInterrupt.failureCount, 0);
      assert.equal(afterInterrupt.status, "ACTIVE");

      await f.pool.query(
        `UPDATE "PublicApiWebhookDelivery" SET "updatedAt"=NOW()-INTERVAL '6 minutes' WHERE id=$1`,
        [job.id],
      );
      release();
      release = undefined;
      assert.equal(await processDueDeliveries(f.pool, f.config, 1), 1);
      const recovered = (await listDeliveries(f.pool, "org", f.id))[0]!;
      assert.equal(recovered.status, "DELIVERED");
      assert.equal(recovered.attemptCount, 2);
      assert.equal(f.received.length, 2);
      assert.equal(f.received[0]!.event, f.received[1]!.event);
      assert.equal((await listSubscriptions(f.pool, "org"))[0]!.failureCount, 0);
    } finally {
      release?.();
      await f.close();
    }
  },
);

test(
  "Killed native delivery process leaves durable claim for lease recovery and stable recipient identity",
  { skip: !database },
  async () => {
    const f = await fixture();
    let child: import("node:child_process").ChildProcess | undefined,
      release: (() => void) | undefined;
    try {
      f.setStatus(204);
      await enqueueDomainEvent(f.pool, "org", "content.post.created", {
        postId: "crash",
        title: "Synthetic recovery",
      });
      const job = (await listDeliveries(f.pool, "org", f.id))[0]!,
        schema = (await f.pool.query("SELECT current_schema() AS schema"))
          .rows[0].schema;
      const paused = f.pause();
      release = paused.release;
      const code = `import pg from 'pg';import {readConfig} from './src/config.ts';import {installPgTimestampParsers} from './src/db.ts';import {processDueDeliveries} from './src/services/public-webhooks.ts';installPgTimestampParsers();const pool=new pg.Pool({connectionString:process.env.WEBHOOK_FIXTURE_DATABASE_URL,options:'-c search_path='+process.env.WEBHOOK_FIXTURE_SCHEMA+' -c timezone=UTC'});try{await processDueDeliveries(pool,readConfig({DATABASE_URL:process.env.WEBHOOK_FIXTURE_DATABASE_URL,PUBLIC_WEBHOOK_ENCRYPTION_KEY:'synthetic-encryption-key'}),1);}finally{await pool.end();}`;
      const { spawn } = await import("node:child_process");
      child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", code],
        {
          cwd: process.cwd(),
          stdio: "ignore",
          env: {
            ...process.env,
            WEBHOOK_FIXTURE_DATABASE_URL: database,
            WEBHOOK_FIXTURE_SCHEMA: schema,
          },
        },
      );
      await Promise.race([
        paused.waiting,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(Error("Native worker did not enter fixture delivery")),
            5000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(
        (await listDeliveries(f.pool, "org", f.id))[0]!.status,
        "DELIVERING",
      );
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      child = undefined;
      assert.equal(await processDueDeliveries(f.pool, f.config, 1), 0);
      await f.pool.query(
        `UPDATE "PublicApiWebhookDelivery" SET "updatedAt"=NOW()-INTERVAL '6 minutes' WHERE id=$1`,
        [job.id],
      );
      release();
      release = undefined;
      assert.equal(await processDueDeliveries(f.pool, f.config, 1), 1);
      const recovered = (await listDeliveries(f.pool, "org", f.id))[0]!;
      assert.equal(recovered.status, "DELIVERED");
      assert.equal(recovered.attemptCount, 2);
      assert.equal(f.received.length, 2);
      assert.equal(f.received[0]!.event, f.received[1]!.event);
      assert.deepEqual(f.received[0]!.body, f.received[1]!.body);
    } finally {
      if (child && child.exitCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
      release?.();
      await f.close();
    }
  },
);
