import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { installPgTimestampParsers } from "../src-ts/db.js";
import { enqueueMissingScopeDefinitions } from "../src-ts/analytics/scope-bootstrap.js";
import { publisherSettings } from "../src-ts/analytics/publisher.js";
import {
  AnalyticsIngestionClient,
  publishOutboxOnce,
} from "@kasitek/server-support/analytics-producer";
const database = process.env.CORE_ANALYTICS_RECOVERY_TEST_DATABASE_URL;
test(
  "competing Analytics publishers exclude an active lease and recover a lost acknowledgement using stable record identity",
  { skip: !database, timeout: 30000 },
  async () => {
    installPgTimestampParsers();
    const db = await isolatedDatabase(database!, "analytics_worker_recovery", [
      "Organization",
      "analytics_outbox",
    ]);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const records: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.equal(request.headers.authorization, "Bearer fixture-token");
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const record = body.records[0];
      records.push(record);
      if (records.length === 1) {
        entered.resolve();
        await release.promise;
        response.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          accepted_count: 0,
          duplicate_count: 1,
          rejected_count: 0,
          retryable_count: 0,
          acknowledgements: [
            {
              source_sequence: record.source_sequence,
              record_id: record.record_id,
              status: "duplicate",
            },
          ],
        }),
      );
    });
    let active: Promise<unknown> | undefined;
    try {
      await db.pool.query(
        `INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('fixture-org','Fixture','fixture-org','fixture-user',NOW(),NOW())`,
      );
      assert.equal(await enqueueMissingScopeDefinitions(db.pool), 1);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert(address && typeof address === "object");
      const settings = publisherSettings({
        ANALYTICS_INGESTION_TOKEN: "fixture-token",
        ANALYTICS_INGESTION_URL: `http://127.0.0.1:${address.port}`,
        ANALYTICS_PUBLISHER_RETRY_BASE_DELAY_MS: "2000",
        ANALYTICS_PUBLISHER_RETRY_JITTER_WINDOW_MS: "0",
      })!;
      const client = new AnalyticsIngestionClient(
        settings.endpoint,
        settings.token,
        5000,
      );
      active = publishOutboxOnce(db.pool, client, {
        ...settings,
        publisher_id: "publisher-a",
      });
      await entered.promise;
      const competitors = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          publishOutboxOnce(db.pool, client, {
            ...settings,
            publisher_id: `publisher-${i}`,
          }),
        ),
      );
      assert(competitors.every((result) => result.claimed === 0));
      assert.equal(records.length, 1);
      release.resolve();
      const failed = (await active) as { retryable: number; delivered: number };
      assert.equal(failed.retryable, 1);
      assert.equal(failed.delivered, 0);
      const retry = (
        await db.pool.query(
          "SELECT delivery_status,attempt_count,lease_owner,lease_expires_at,last_error_code,next_attempt_at FROM analytics_outbox",
        )
      ).rows[0];
      assert.equal(retry.delivery_status, "pending");
      assert.equal(retry.attempt_count, 1);
      assert.equal(retry.lease_owner, null);
      assert.equal(retry.lease_expires_at, null);
      assert.equal(retry.last_error_code, "analytics.transport_unavailable");
      assert.equal(
        (
          await publishOutboxOnce(
            db.pool,
            client,
            settings,
            new Date(retry.next_attempt_at.getTime() - 1),
          )
        ).claimed,
        0,
      );
      const recovered = await publishOutboxOnce(
        db.pool,
        client,
        { ...settings, publisher_id: "recovery-publisher" },
        new Date(retry.next_attempt_at),
      );
      assert.equal(recovered.delivered, 1);
      assert.equal(records.length, 2);
      assert.deepEqual(records[0], records[1]);
      const final = (
        await db.pool.query(
          "SELECT delivery_status,attempt_count,lease_owner,delivered_at IS NOT NULL AS delivered FROM analytics_outbox",
        )
      ).rows[0];
      assert.deepEqual(final, {
        delivery_status: "delivered",
        attempt_count: 2,
        lease_owner: null,
        delivered: true,
      });
    } finally {
      release.resolve();
      if (active) await Promise.allSettled([active]);
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    }
  },
);
