import test from "node:test";
import { prepareValidators } from "../src-ts/registry.js";
await prepareValidators();
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { analyticsFixture } from "./database-fixture.js";
import {
  canonicalJson,
  parseSerdeValueJson,
  serdeFloat,
} from "@kasitek/server-support/json";
import {
  IngestionAuthenticator,
  ingestBatch,
  ingestBatchWithRepair,
  validateRecord,
  advanceCursor,
  parseIngestionBatch,
  type IngestionRecord,
} from "../src-ts/ingestion.js";
import { canonicalPayloadSha256, normalizedTime } from "../src-ts/records.js";
import { reconcileStream } from "../src-ts/reconciliation.js";
const authenticated = {
  source_service: "core",
  producer_id: "core-customer-analytics",
};
export function record(
  category: IngestionRecord["record_category"],
  id: string,
  sequence: bigint,
  data: Record<string, unknown>,
  scope = "fixture-org",
  stream = "fixture-stream",
): IngestionRecord {
  const contract =
    category === "event"
      ? "campaign.recipient.sent@1"
      : category === "scope_definition"
        ? "core.scope.definition@1"
        : category === "manifest"
          ? "source.manifest@1"
          : "campaign.delivery.observation@1";
  return {
    producer_id: authenticated.producer_id,
    source_stream_key: stream,
    source_sequence: sequence,
    record_category: category,
    record_id: id,
    contract_name: contract,
    schema_version: 1,
    scope_kind: "core_organization",
    scope_external_id: scope,
    payload_hash: canonicalPayloadSha256(data),
    envelope: {
      specversion: "1.0",
      id: `00000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
      source: "kasitek://core",
      type: contract,
      subject: "recipient:fixture-recipient",
      time: "2026-08-22T12:00:00.123456Z",
      datacontenttype: "application/json",
      dataschema:
        "https://kasitek.co.za/analytics/contracts/events/campaign/recipient_sent/v1.schema.json",
      source_service: "core",
      source_domain: "campaigns",
      record_category: category,
      scope_kind: "core_organization",
      scope_external_id: scope,
      data,
    },
  };
}
const eventData = {
  campaign_id: "campaign-fixture",
  recipient_id: "recipient-fixture",
  channel: "whatsapp",
  status: "sent",
  occurred_at: "2026-08-22T12:00:00Z",
};
const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;
test("ingestion auth, canonical numeric values, privacy and exact cursor arithmetic", () => {
  const auth = new IngestionAuthenticator([
    {
      ...authenticated,
      token_sha256: createHash("sha256").update("fixture-token").digest("hex"),
    },
  ]);
  assert.deepEqual(
    auth.authenticate({ headers: { authorization: "Bearer fixture-token" } }),
    authenticated,
  );
  assert.throws(() =>
    auth.authenticate({ headers: { authorization: "bearer fixture-token" } }),
  );
  const high = 9007199254740993n;
  const [received, contiguous, gaps] = advanceCursor(
    high - 3n,
    high - 3n,
    [],
    high,
  );
  assert.equal(received, high);
  assert.equal(contiguous, high - 3n);
  assert.deepEqual(gaps, [{ start: high - 2n, end: high - 1n }]);
  assert.deepEqual(advanceCursor(received, contiguous, gaps, high - 2n)[2], [
    { start: high - 1n, end: high - 1n },
  ]);
  const r = record("scope_definition", "scope-fixture", 1n, {
    scope_kind: "core_organization",
    scope_external_id: "fixture-org",
    reporting_timezone: "UTC",
    status: "active",
    source_version: serdeFloat(1),
  });
  assert.throws(
    () => validateRecord(r, authenticated),
    /invalid_scope_version/,
  );
  assert.throws(() =>
    parseIngestionBatch(
      parseSerdeValueJson(
        canonicalJson({ records: [{ ...r, source_sequence: serdeFloat(1) }] }),
      ),
    ),
  );
  assert.equal(
    normalizedTime("2026-08-22T14:00:00.1234+02:00"),
    "2026-08-22T12:00:00.123400Z",
  );
});
test(
  "source-shaped receipts/facts/observations/manifests, duplicates/conflicts and reconciliation cursor",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture();
    try {
      const scope = record("scope_definition", "scope-one", 1n, {
        scope_kind: "core_organization",
        scope_external_id: "fixture-org",
        reporting_timezone: "UTC",
        status: "active",
        source_version: 9007199254740993n,
      });
      let result = await ingestBatch(f.pool, authenticated, {
        records: [scope],
      });
      assert.equal(result.accepted_count, 1);
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [scope] }))
          .duplicate_count,
        1,
      );
      const event = record("event", "event-three", 3n, eventData);
      result = await ingestBatch(f.pool, authenticated, { records: [event] });
      assert.equal(result.accepted_count, 1, canonicalJson(result));
      const observation = record("observation", "observation-two", 2n, {
        provider: "fixture-provider",
        metric_key: "campaign.recipients.sent",
        numeric_value: serdeFloat(1),
        unit: "count",
        reporting_window_start: "2026-08-22T11:00:00.123456Z",
        reporting_window_end: "2026-08-22T12:00:00.123456Z",
        observed_at: "2026-08-22T12:00:00.123456Z",
        synchronization_run_id: "sync-fixture",
        dimensions: { channel: "whatsapp" },
        source_evidence: { provider_request_id: "fixture-request" },
      });
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [observation] }))
          .accepted_count,
        1,
      );
      const data = {
        manifest_key: "fixture-manifest",
        manifest_version: 1,
        provider: "fixture-provider",
        connection_ref: "fixture-connection",
        supported_contracts: ["campaign.recipient.sent@1"],
        supported_observation_contracts: ["campaign.delivery.observation@1"],
        supported_metrics: ["campaign.recipients.sent"],
        supported_dimensions: ["channel"],
        expected_refresh_seconds: 300,
        approved_checkpoint_count: 3,
        manifest_state: "active",
        generated_at: "2026-08-22T12:00:00.123456Z",
      };
      const manifest = record(
        "manifest",
        "manifest:fixture-stream:fixture-manifest:1",
        4n,
        data,
      );
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [manifest] }))
          .accepted_count,
        1,
      );
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [manifest] }))
          .duplicate_count,
        1,
      );
      const cursor = (
        await f.pool.query("SELECT * FROM analytics.analytics_source_cursor")
      ).rows[0]!;
      assert.equal(BigInt(cursor.highest_contiguous_sequence), 4n);
      assert.deepEqual(cursor.known_gap_ranges, []);
      const row = (
        await f.pool.query(
          "SELECT occurred_at,attributes FROM analytics.analytics_event",
        )
      ).rows[0]!;
      assert.equal(
        row.occurred_at.toISOString(),
        "2026-08-22T12:00:00.123456Z",
      );
      assert.deepEqual(row.attributes, eventData);
      const state = (
        await f.pool.query(
          "SELECT * FROM analytics.analytics_source_state WHERE latest_manifest_id IS NOT NULL",
        )
      ).rows[0]!;
      assert.equal(state.availability_state, "available");
      assert.equal(state.next_attempt_at, null);
      const coverage = (
        await f.pool.query(
          "SELECT window_end FROM analytics.analytics_coverage_checkpoint WHERE coverage_layer='source'",
        )
      ).rows[0]!;
      assert.equal(
        coverage.window_end.toISOString(),
        "2026-08-22T12:05:00.123456Z",
      );
      const conflict = record("event", "different-id", 3n, eventData);
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [conflict] }))
          .acknowledgements[0]?.error_code,
        "identity_conflict",
      );
      const privacy = record("event", "privacy-five", 5n, {
        ...eventData,
        nested: { email: "fixture@example.invalid" },
      });
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [privacy] }))
          .acknowledgements[0]?.error_code,
        "prohibited_field",
      );
      const reconcile = await reconcileStream(f.pool, authenticated, {
        reconciliation_run_id: "fixture-reconcile",
        producer_id: authenticated.producer_id,
        source_domain: "campaigns",
        source_stream_key: "fixture-stream",
        scope_kind: "core_organization",
        scope_external_id: "fixture-org",
        source_highest_outbox_sequence: 7n,
        source_highest_delivered_sequence: 7n,
        authoritative_count: 4n,
      });
      assert.equal(reconcile.reconciliation_status, "mismatch");
      assert.equal(reconcile.analytics_count, 4n);
      assert.deepEqual(reconcile.missing_sequence_ranges, [
        { start: 5n, end: 7n },
      ]);
      assert.equal(reconcile.unresolved_quarantine_count, 2n);
      assert.equal(
        (
          await f.pool.query(
            "SELECT COUNT(*) FROM analytics.analytics_projection_work WHERE repair_reason IS NOT NULL",
          )
        ).rows[0]?.count,
        "2",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "source reconstruction counters/coverage and leased quarantine repair commit with immutable facts",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture();
    try {
      const scope = record(
        "scope_definition",
        "scope-repair",
        1n,
        {
          scope_kind: "core_organization",
          scope_external_id: "fixture-org",
          reporting_timezone: "UTC",
          status: "active",
          source_version: 1,
        },
        "fixture-org",
        "scope-stream",
      );
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [scope] }))
          .accepted_count,
        1,
      );
      const scopeId = (
        await f.pool.query("SELECT scope_id FROM analytics.reporting_scope")
      ).rows[0]!.scope_id;
      const bad = record(
        "event",
        "repair-event",
        1n,
        { ...eventData, email: "fixture@example.invalid" },
        "fixture-org",
        "repair-stream",
      );
      assert.equal(
        (await ingestBatch(f.pool, authenticated, { records: [bad] }))
          .rejected_count,
        1,
      );
      const failure = (
        await f.pool.query(
          "SELECT failure_id FROM analytics.analytics_ingestion_failure",
        )
      ).rows[0]!.failure_id;
      await f.pool.query(
        `INSERT INTO analytics.analytics_quarantine_release_work(failure_id,producer_id,source_service,source_domain,source_stream_key,source_sequence,record_category,schema_version,record_identity,payload_hash,work_status,lease_owner,lease_expires_at) SELECT failure_id,producer_id,source_service,source_domain,source_stream_key,source_sequence,record_category,schema_version,record_identity,payload_hash,'leased',producer_id,NOW()+INTERVAL '1 minute' FROM analytics.analytics_ingestion_failure WHERE failure_id=$1`,
        [failure],
      );
      const corrected = record(
        "event",
        "repair-event",
        1n,
        eventData,
        "fixture-org",
        "repair-stream",
      );
      assert.equal(
        (
          await ingestBatchWithRepair(
            f.pool,
            authenticated,
            { records: [corrected] },
            { failure_id: BigInt(failure), transform_version: "fixture-v1" },
          )
        ).accepted_count,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT quarantine_status,repair_transform_version FROM analytics.analytics_ingestion_failure",
          )
        ).rows[0]!.quarantine_status,
        "released",
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT work_status FROM analytics.analytics_quarantine_release_work",
          )
        ).rows[0]!.work_status,
        "released",
      );
      assert.equal(
        (
          await ingestBatchWithRepair(
            f.pool,
            authenticated,
            { records: [corrected] },
            { failure_id: BigInt(failure), transform_version: "fixture-v1" },
          )
        ).acknowledgements[0]?.error_code,
        "repair_not_authorized",
      );
      for (const [id, method] of [
        ["fixture-source", "source_reconstruction"],
        ["fixture-replay", "fact_replay"],
        ["fixture-partial", "source_reconstruction"],
      ])
        await f.pool.query(
          `INSERT INTO analytics.analytics_backfill_job(job_id,source_service,source_domain,reporting_scope_id,root_scope_id,requested_range_start,requested_range_end,contract_version,method,job_status,remaining_count,requesting_actor_type,requesting_actor_id,authorization_grant_id,started_at) VALUES($1,'core','campaigns',$2,$2,'2026-08-22T11:00:00.123456Z','2026-08-22T13:00:00.123456Z','campaign.recipient.sent@1',$3,'running',1,'test','fixture','fixture-grant',NOW())`,
          [id, scopeId, method],
        );
      for (const job of [
        "fixture-source",
        "fixture-replay",
        "fixture-partial",
      ]) {
        const r = record(
          "event",
          job,
          1n,
          job === "fixture-partial"
            ? { ...eventData, phone_number: "fixture" }
            : eventData,
          "fixture-org",
          job + "-stream",
        );
        const result = await ingestBatch(f.pool, authenticated, {
          records: [r],
          backfill_job_id: job,
        });
        assert.equal(
          job === "fixture-partial"
            ? result.rejected_count
            : result.accepted_count,
          1,
          canonicalJson(result),
        );
        assert.equal(
          (
            await f.pool.query(
              "SELECT job_status FROM analytics.analytics_backfill_job WHERE job_id=$1",
              [job],
            )
          ).rows[0]!.job_status,
          "completed",
        );
      }
      const coverage = (
        await f.pool.query(
          "SELECT backfill_job_id,coverage_state,included_count,excluded_count,complete_through,window_end FROM analytics.analytics_coverage_checkpoint WHERE coverage_layer='temporal' ORDER BY backfill_job_id",
        )
      ).rows;
      assert.equal(coverage.length, 2);
      assert.equal(
        coverage
          .find((v) => v.backfill_job_id === "fixture-source")
          ?.complete_through.toISOString(),
        "2026-08-22T13:00:00.123456Z",
      );
      assert.equal(
        coverage.find((v) => v.backfill_job_id === "fixture-partial")
          ?.coverage_state,
        "partial",
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*) FROM analytics.analytics_source_cursor WHERE source_stream_key LIKE 'fixture-%-stream'",
          )
        ).rows[0]!.count,
        "0",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "competing ingestion transactions preserve one immutable identity and retry safely",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture();
    try {
      await f.pool.query(
        "INSERT INTO analytics.reporting_scope(scope_kind,owning_source_service,external_source_id,status,reporting_timezone) VALUES('core_organization','core','fixture-org','active','UTC')",
      );
      const event = record("event", "competing-event", 1n, eventData);
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          ingestBatch(f.pool, authenticated, { records: [event] }),
        ),
      );
      assert.equal(
        outcomes.reduce((sum, r) => sum + r.accepted_count, 0),
        1,
      );
      assert.ok(outcomes.every((r) => r.rejected_count === 0));
      for (const result of outcomes)
        if (result.retryable_count)
          assert.equal(
            (await ingestBatch(f.pool, authenticated, { records: [event] }))
              .duplicate_count,
            1,
          );
      assert.equal(
        (await f.pool.query("SELECT COUNT(*) FROM analytics.analytics_event"))
          .rows[0]!.count,
        "1",
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT highest_contiguous_sequence FROM analytics.analytics_source_cursor",
          )
        ).rows[0]!.highest_contiguous_sequence,
        "1",
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "native ingestion/reconciliation/rollout registrars preserve auth, strict extractors and exact IDs",
  { skip: !enabled },
  async () => {
    const [
      { default: Fastify },
      { registerIngestionRoutes },
      { registerReconciliationRoutes },
      { registerRolloutRoutes },
      { loadRegistry },
      { ProcessMetrics },
      { apiJson },
      { RequestExtractionError },
    ] = await Promise.all([
      import("fastify"),
      import("../src-ts/ingestion.js"),
      import("../src-ts/reconciliation.js"),
      import("../src-ts/rollout.js"),
      import("../src-ts/registry.js"),
      import("../src-ts/metrics.js"),
      import("../src-ts/json.js"),
      import("../src-ts/error.js"),
    ]);
    const f = await analyticsFixture({
      ANALYTICS_INGESTION_CREDENTIALS_JSON: JSON.stringify([
        { ...authenticated, token: "fixture-token" },
      ]),
      ANALYTICS_ROLLOUT_ADMIN_PRODUCERS: authenticated.producer_id,
    });
    const app = Fastify();
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser(
      "application/json",
      { parseAs: "string" },
      (_request, body, done) => {
        try {
          done(null, parseSerdeValueJson(String(body)));
        } catch (error) {
          done(error as Error);
        }
      },
    );
    app.setReplySerializer((value) => apiJson(value));
    app.setErrorHandler((error, _request, reply) =>
      error instanceof RequestExtractionError
        ? reply.type("text/plain").code(400).send(error.message)
        : reply.code(500).send({ error: "fixture-failure" }),
    );
    try {
      const context = {
        pool: f.pool,
        config: f.config,
        registry: await loadRegistry(),
        metrics: new ProcessMetrics(),
      };
      registerIngestionRoutes(app, context);
      registerReconciliationRoutes(app, context);
      registerRolloutRoutes(app, context);
      const headers = {
        authorization: "Bearer fixture-token",
        "content-type": "application/json",
      };
      const r = record("scope_definition", "http-scope", 1n, {
        scope_kind: "core_organization",
        scope_external_id: "fixture-org",
        reporting_timezone: "UTC",
        status: "active",
        source_version: 9007199254740993n,
      });
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/internal/ingest/v1/batch",
            payload: canonicalJson({ records: [r] }),
            headers: { "content-type": "application/json" },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/internal/ingest/v1/batch",
            payload: canonicalJson({
              records: [{ ...r, source_sequence: serdeFloat(1) }],
            }),
            headers,
          })
        ).statusCode,
        400,
      );
      const response = await app.inject({
        method: "POST",
        url: "/internal/ingest/v1/batch",
        payload: canonicalJson({ records: [r] }),
        headers,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().accepted_count, 1);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/internal/ingest/v1/batch",
            payload: canonicalJson({ records: [r], unknown: true }),
            headers,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/internal/rollouts/v1/evaluate?control_key=report",
            headers,
          })
        ).json().allowed,
        false,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/internal/rollouts/v1/evaluate?control_key=report&reporting_scope_id=1.0",
            headers,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/internal/rollouts/v1/controls",
            payload: canonicalJson({
              control_key: "report",
              target: { kind: "global", key: "global" },
              enabled: true,
              reason: "fixture approval",
            }),
            headers,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: "/internal/rollouts/v1/evaluate?control_key=report",
            headers,
          })
        ).json().allowed,
        true,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/internal/rollouts/v1/expire",
            headers: { authorization: "Bearer fixture-token" },
          })
        ).json().closed_count,
        0,
      );
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/internal/reconciliation/v1/summary",
            payload: canonicalJson({
              reconciliation_run_id: "http-run",
              producer_id: authenticated.producer_id,
              source_domain: "campaigns",
              source_stream_key: "fixture-stream",
              authoritative_count: 1,
            }),
            headers,
          })
        ).statusCode,
        200,
      );
    } finally {
      await app.close();
      await f.close();
    }
  },
);
