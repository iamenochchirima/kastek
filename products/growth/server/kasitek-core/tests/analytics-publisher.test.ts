import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import pg from 'pg';
import { enqueueOrganizationScopeDefinition } from '../src/analytics/index.js';
import { enqueueMissingScopeDefinitions } from '../src/analytics/scope-bootstrap.js';
import { installPgTimestampParsers, transaction } from '../src/db.js';
import {
  publisherSettings,
  runAnalyticsPublisher,
} from '../src/analytics/publisher.js';

installPgTimestampParsers();

test(
  'Growth Analytics worker defaults, primary-token selection and retry configuration retain source semantics',
  () => {
    assert.equal(publisherSettings({}), undefined);
    assert.equal(
      publisherSettings({
        ANALYTICS_CORE_INGESTION_TOKEN: ' ',
        ANALYTICS_INGESTION_TOKEN: 'fallback',
      }),
      undefined,
    );

    const settings = publisherSettings({
      ANALYTICS_INGESTION_TOKEN: 'fixture',
      ANALYTICS_PUBLISHER_BATCH_SIZE: '999',
      ANALYTICS_PUBLISHER_RETRY_BASE_DELAY_MS: '9750',
    });
    assert.equal(settings?.batch_size, 500);
    assert.equal(settings?.producer_id, 'core-customer-analytics');
    assert.equal(settings?.retry_policy.base_delay_ms, 9750);
  },
);

test(
  'Growth publisher recovers expired leases and pages reconciliation summaries',
  { skip: !process.env.CORE_ANALYTICS_TEST_DATABASE_URL },
  async () => {
    const url = process.env.CORE_ANALYTICS_TEST_DATABASE_URL!;
    const schema = `analytics_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });

    const requests: { path: string; body: Record<string, unknown> }[] = [];
    let reconciliationRequests = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(
          Buffer.concat(chunks).toString(),
        ) as Record<string, unknown>;
        const path = request.url ?? '';
        requests.push({ path, body });
        assert.equal(
          request.headers.authorization,
          'Bearer synthetic-token',
        );
        response.writeHead(200, { 'content-type': 'application/json' });

        if (path === '/internal/ingest/v1/batch') {
          const records = body.records as Record<string, unknown>[];
          response.end(
            JSON.stringify({
              accepted_count: records.length,
              duplicate_count: 0,
              rejected_count: 0,
              retryable_count: 0,
              acknowledgements: records.map((record) => ({
                source_sequence: record.source_sequence,
                record_id: record.record_id,
                status: 'accepted',
              })),
            }),
          );
          return;
        }

        assert.equal(path, '/internal/reconciliation/v1/summary');
        reconciliationRequests += 1;
        const mismatched = reconciliationRequests === 1;
        response.end(
          JSON.stringify({
            reconciliation_status: mismatched ? 'mismatch' : 'complete',
            analytics_highest_received_sequence: 1,
            analytics_highest_contiguous_sequence: 1,
            missing_sequence_ranges: mismatched
              ? [{ start_sequence: 2, end_sequence: 2 }]
              : [],
            unresolved_quarantine_count: 0,
            analytics_count: 1,
          }),
        );
      });
    });

    const controller = new AbortController();
    const logs: Record<string, unknown>[] = [];
    let reconciliationBatches = 0;
    const log = {
      info(data: Record<string, unknown>) {
        logs.push(data);
        if (
          data.phase === 'reconciliation' &&
          data.attempted === 1 &&
          ++reconciliationBatches === 2
        )
          controller.abort();
      },
      warn(data: Record<string, unknown>) {
        logs.push(data);
      },
      error(data: Record<string, unknown>) {
        logs.push(data);
        controller.abort();
      },
    };
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      await pool.query(`
        CREATE TABLE "Organization" (
          id text,
          "createdAt" timestamp,
          "reportingTimezone" text
        );
        INSERT INTO "Organization" VALUES
          ('synthetic-org-a', '2030-01-01T00:00:00', 'UTC'),
          ('synthetic-org-b', '2030-01-01T00:00:00', 'UTC');
        CREATE TABLE analytics_outbox (
          outbox_id text PRIMARY KEY,
          source_service text,
          source_domain text,
          source_stream_key text,
          record_category text,
          record_id text,
          contract_name text,
          schema_version integer,
          scope_kind text,
          scope_external_id text,
          idempotency_key text,
          envelope jsonb,
          payload_hash text,
          source_sequence bigserial,
          delivery_status text DEFAULT 'pending',
          attempt_count integer DEFAULT 0,
          next_attempt_at timestamptz DEFAULT NOW(),
          lease_owner text,
          lease_expires_at timestamptz,
          last_error_code text,
          created_at timestamptz DEFAULT NOW(),
          updated_at timestamptz DEFAULT NOW(),
          delivered_at timestamptz,
          quarantined_at timestamptz,
          UNIQUE (source_service, record_category, record_id)
        );
      `);
      await transaction(pool, (tx) =>
        enqueueOrganizationScopeDefinition(
          tx,
          'synthetic-org-a',
          1,
          'UTC',
          'active',
        ),
      );
      await pool.query(`
        UPDATE analytics_outbox
        SET delivery_status = 'leased',
            lease_owner = 'publisher-before-restart',
            lease_expires_at = NOW() - INTERVAL '1 second'
        WHERE scope_external_id = 'synthetic-org-a'
      `);
      assert.equal(await enqueueMissingScopeDefinitions(pool), 1);
      assert.equal(await enqueueMissingScopeDefinitions(pool), 0);

      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      await runAnalyticsPublisher(
        pool,
        {
          ANALYTICS_INGESTION_URL: `http://127.0.0.1:${address.port}`,
          ANALYTICS_INGESTION_TOKEN: 'synthetic-token',
          ANALYTICS_PUBLISHER_POLL_INTERVAL_MS: '1',
          ANALYTICS_RECONCILIATION_INTERVAL_MS: '5',
          ANALYTICS_RECONCILIATION_MAX_STREAMS: '1',
        },
        log,
        controller.signal,
      );

      const publication = logs.find((row) => row.phase === 'publication');
      assert.equal(publication?.leases_released, 1);
      assert.equal(publication?.claimed, 2);
      assert.equal(publication?.delivered, 2);

      const rows = (
        await pool.query(`
          SELECT source_sequence, delivery_status, attempt_count,
                 lease_owner, scope_external_id
          FROM analytics_outbox
          ORDER BY source_sequence
        `)
      ).rows;
      assert.deepEqual(
        rows.map((row) => row.scope_external_id),
        ['synthetic-org-a', 'synthetic-org-b'],
      );
      assert.ok(
        rows.every(
          (row) =>
            row.delivery_status === 'delivered' &&
            row.attempt_count === 1 &&
            row.lease_owner === null,
        ),
      );

      const reconciliations = requests
        .filter((request) => request.path === '/internal/reconciliation/v1/summary')
        .map((request) => request.body);
      assert.equal(reconciliations.length, 2);
      assert.deepEqual(
        reconciliations.map((row) => row.source_stream_key),
        [
          'organization:synthetic-org-a:scopes',
          'organization:synthetic-org-b:scopes',
        ],
      );
      assert.deepEqual(
        reconciliations.map((row) => row.source_highest_outbox_sequence),
        [1, 2],
      );
      assert.deepEqual(
        reconciliations.map((row) => row.source_highest_delivered_sequence),
        [1, 2],
      );
      assert.deepEqual(
        reconciliations.map((row) => row.authoritative_count),
        [1, 1],
      );
      assert.ok(
        reconciliations.every(
          (row) =>
            row.producer_id === 'core-customer-analytics' &&
            typeof row.reconciliation_run_id === 'string',
        ),
      );
      assert.deepEqual(
        logs
          .filter((row) => row.phase === 'reconciliation')
          .map((row) => row.mismatched),
        [1, 0],
      );
    } finally {
      clearTimeout(timeout);
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
