import test from "node:test";
import assert from "node:assert/strict";
import { analyticsFixture } from "./database-fixture.js";
import { loadRegistry } from "../src/registry.js";
import { transaction } from "../src/db.js";
import {
  enqueueFact,
  processOnce,
  claimWork,
  requestRebuild,
  enqueueReplayRange,
  enqueueReconciliationRepair,
  hourlyWindow,
} from "../src/projections.js";
import type { Pool } from "pg";
const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;
const scalar = async (pool: Pool, sql: string, values: unknown[] = []) =>
  Object.values((await pool.query(sql, values)).rows[0]!)[0];
async function scope(
  pool: Pool,
  kind: string,
  service: string,
  external: string,
  timezone = "UTC",
  parent: bigint | null = null,
) {
  return BigInt(
    (await scalar(
      pool,
      `INSERT INTO analytics.reporting_scope(scope_kind,owning_source_service,external_source_id,parent_scope_id,status,reporting_timezone,source_version) VALUES($1,$2,$3,$4,'active',$5,1788020091680) RETURNING scope_id`,
      [kind, service, external, parent, timezone],
    )) as string,
  );
}
async function event(
  pool: Pool,
  id: string,
  type: string,
  target: bigint,
  root: bigint,
  attrs: unknown,
  time = "2026-08-22T23:30:00Z",
  service = "core",
  domain = "campaigns",
) {
  return BigInt(
    (await scalar(
      pool,
      `INSERT INTO analytics.analytics_event(producer_id,source_service,source_domain,source_stream_key,source_sequence,event_id,event_type,schema_version,reporting_scope_id,root_scope_id,subject_type,subject_id,occurred_at,origin,source_record_id,attributes,payload_hash) VALUES($1,$2,$3,$4,1,$4,$5,1,$6,$7,'fixture_subject','fixture-subject',$8,'test://typescript-projection',$4,$9,repeat('a',64)) RETURNING storage_id`,
      [
        service === "core"
          ? "core-customer-analytics"
          : "agent-platform-customer-analytics",
        service,
        domain,
        id,
        type,
        target,
        root,
        time,
        JSON.stringify(attrs),
      ],
    )) as string,
  );
}
async function enqueue(
  pool: Pool,
  target: bigint,
  root: bigint,
  storage: bigint,
  time = "2026-08-22T23:30:00Z",
) {
  const [start, end] = hourlyWindow(new Date(time));
  await transaction(pool, (tx) =>
    enqueueFact(tx, {
      fact_kind: "event",
      reporting_scope_id: target,
      root_scope_id: root,
      source_storage_id: storage,
      source_window_start: start,
      source_window_end: end,
    }),
  );
  return [start, end] as const;
}
test(
  "durable projections preserve ratio/distinct/weighted math, generations, replay, failure rollback and immutable inputs",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture();
    try {
      const registry = await loadRegistry(),
        org = await scope(
          f.pool,
          "core_organization",
          "core",
          "projection-org",
        );
      const attrs = {
        campaign_id: "campaign",
        recipient_id: "recipient",
        channel: "whatsapp",
        status: "sent",
      };
      const sent = await event(
        f.pool,
        "sent",
        "campaign.recipient.sent@1",
        org,
        org,
        attrs,
      );
      await event(
        f.pool,
        "sent-repeat",
        "campaign.recipient.sent@1",
        org,
        org,
        attrs,
      );
      const delivered = await event(
        f.pool,
        "delivered",
        "campaign.recipient.delivered@1",
        org,
        org,
        { ...attrs, status: "delivered" },
      );
      const timing = await event(
        f.pool,
        "timing",
        "campaign.recipient.timing@1",
        org,
        org,
        { ...attrs, timing_kind: "delivery", duration_ms: 125.5 },
      );
      const window = await enqueue(f.pool, org, org, timing);
      assert.equal(
        await processOnce(f.pool, registry, "fixture-worker", 60),
        true,
      );
      const generation = BigInt(
        (await scalar(
          f.pool,
          `SELECT generation_id FROM analytics.analytics_projection_checkpoint WHERE reporting_scope_id=$1`,
          [org],
        )) as string,
      );
      assert.equal(
        await scalar(
          f.pool,
          `SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id=$1`,
          [generation],
        ),
        "promoted",
      );
      const rollups = (
        await f.pool.query(
          `SELECT metric_key,interval,value_count::text,value_sum::double precision FROM analytics.analytics_projection_rollup WHERE generation_id=$1 AND interval='hour'`,
          [generation],
        )
      ).rows;
      assert.equal(
        rollups.find((r) => r.metric_key === "campaign.recipients.sent")!
          .value_count,
        "1",
      );
      assert.equal(
        rollups.find((r) => r.metric_key === "campaign.delivery_rate")!
          .value_sum,
        0.5,
      );
      assert.equal(
        rollups.find((r) => r.metric_key === "campaign.delivery_delay_ms")!
          .value_sum,
        125.5,
      );
      assert.equal(
        await scalar(f.pool, `SELECT count(*) FROM analytics.analytics_event`),
        "4",
      );
      assert.equal(await enqueueReplayRange(f.pool, org, org, ...window), 1n);
      assert.equal(
        await processOnce(f.pool, registry, "fixture-replay", 60),
        true,
      );
      assert.equal(
        await scalar(
          f.pool,
          `SELECT count(*) FROM analytics.analytics_projection_work WHERE reporting_scope_id=$1`,
          [org],
        ),
        "1",
      );
      assert.equal(
        await scalar(f.pool, `SELECT count(*) FROM analytics.analytics_event`),
        "4",
      );
      assert.equal(
        await scalar(
          f.pool,
          `SELECT value_count FROM analytics.analytics_projection_rollup WHERE generation_id=$1 AND metric_key='campaign.recipients.sent' AND interval='hour'`,
          [generation],
        ),
        "1",
      );
      const rebuilt = await requestRebuild(
        f.pool,
        org,
        org,
        "fixture-request",
        registry.sha256,
      );
      assert.notEqual(rebuilt, generation);
      assert.equal(
        BigInt(
          (await scalar(
            f.pool,
            `SELECT generation_id FROM analytics.analytics_projection_checkpoint WHERE reporting_scope_id=$1`,
            [org],
          )) as string,
        ),
        generation,
      );
      assert.equal(
        await processOnce(f.pool, registry, "fixture-shadow", 60),
        true,
      );
      assert.equal(
        await scalar(
          f.pool,
          `SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id=$1`,
          [generation],
        ),
        "superseded",
      );
      assert.equal(
        await scalar(
          f.pool,
          `SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id=$1`,
          [rebuilt],
        ),
        "promoted",
      );
      assert.equal(
        await enqueueReconciliationRepair(
          f.pool,
          "core-customer-analytics",
          "sent",
          org,
          org,
        ),
        1n,
      );
      assert.equal(
        await processOnce(f.pool, registry, "fixture-repair", 60),
        true,
      );
      const broken = await scope(
        f.pool,
        "core_organization",
        "core",
        "broken-org",
      );
      const badEvent = await event(
        f.pool,
        "missing-campaign",
        "campaign.recipient.sent@1",
        broken,
        broken,
        { recipient_id: "recipient", channel: "whatsapp", status: "sent" },
      );
      await enqueue(f.pool, broken, broken, badEvent);
      const leased = await claimWork(f.pool, "fixture-lease", 60);
      assert.equal(leased!.reporting_scope_id, broken);
      assert.equal(await claimWork(f.pool, "fixture-other", 60), null);
      await f.pool.query(
        `UPDATE analytics.analytics_projection_work SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1`,
        [leased!.work_id],
      );
      await assert.rejects(
        processOnce(f.pool, registry, "fixture-failure", 60),
        /typed projection builder missing campaign_id/,
      );
      const work = (
        await f.pool.query(
          `SELECT work_status,attempt_count,lease_owner,last_error_code,available_at>NOW() AS delayed FROM analytics.analytics_projection_work WHERE reporting_scope_id=$1`,
          [broken],
        )
      ).rows[0]!;
      assert.deepEqual(work, {
        work_status: "failed",
        attempt_count: 2,
        lease_owner: null,
        last_error_code: "projection_failed",
        delayed: true,
      });
      assert.equal(
        await scalar(
          f.pool,
          `SELECT count(*) FROM analytics.analytics_projection_generation WHERE reporting_scope_id=$1`,
          [broken],
        ),
        "0",
      );
      assert.equal(
        await scalar(
          f.pool,
          `SELECT count(*) FROM analytics.analytics_event WHERE reporting_scope_id=$1`,
          [broken],
        ),
        "1",
      );
      const empty = await scope(
        f.pool,
        "core_organization",
        "core",
        "empty-org",
      );
      const emptyGeneration = await requestRebuild(
        f.pool,
        empty,
        empty,
        "fixture",
        registry.sha256,
      );
      assert.equal(
        await scalar(
          f.pool,
          `SELECT generation_status FROM analytics.analytics_projection_generation WHERE generation_id=$1`,
          [emptyGeneration],
        ),
        "promoted",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "deleted-scope work is cancelled and a replacement worker reclaims an expired lease",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture();
    try {
      const registry = await loadRegistry();
      const deletedScope = await scope(
        f.pool,
        "core_organization",
        "core",
        `deleted-projection-${Date.now()}`,
      );
      const deletedEvent = await event(
        f.pool,
        "deleted-scope-event",
        "campaign.recipient.sent@1",
        deletedScope,
        deletedScope,
        { campaign_id: "campaign", recipient_id: "recipient", channel: "whatsapp", status: "sent" },
      );
      await enqueue(f.pool, deletedScope, deletedScope, deletedEvent);
      await f.pool.query(
        "UPDATE analytics.reporting_scope SET status='deleted' WHERE scope_id=$1",
        [deletedScope],
      );
      assert.equal(
        await processOnce(f.pool, registry, "worker-after-delete", 60),
        false,
      );
      assert.equal(
        await scalar(
          f.pool,
          "SELECT count(*) FROM analytics.analytics_projection_contribution WHERE source_scope_id=$1",
          [deletedScope],
        ),
        "0",
      );
      assert.equal(
        await scalar(
          f.pool,
          "SELECT count(*) FROM analytics.analytics_projection_rollup WHERE source_scope_id=$1",
          [deletedScope],
        ),
        "0",
      );
      const deletedWork = await f.pool.query<{
        work_status: string;
        last_error_code: string | null;
        attempt_count: number;
      }>(
        "SELECT work_status,last_error_code,attempt_count FROM analytics.analytics_projection_work WHERE reporting_scope_id=$1",
        [deletedScope],
      );
      assert.deepEqual(deletedWork.rows, [
        {
          work_status: "cancelled",
          last_error_code: "scope_deleted",
          attempt_count: 0,
        },
      ]);

      const resumedScope = await scope(
        f.pool,
        "core_organization",
        "core",
        `restarted-projection-${Date.now()}`,
      );
      const resumedEvent = await event(
        f.pool,
        "restarted-worker-event",
        "campaign.recipient.sent@1",
        resumedScope,
        resumedScope,
        { campaign_id: "campaign", recipient_id: "recipient", channel: "whatsapp", status: "sent" },
      );
      await enqueue(f.pool, resumedScope, resumedScope, resumedEvent);
      const abandoned = await claimWork(f.pool, "worker-before-restart", 60);
      assert.equal(abandoned?.reporting_scope_id, resumedScope);
      await f.pool.query(
        "UPDATE analytics.analytics_projection_work SET lease_expires_at=NOW()-INTERVAL '1 second' WHERE work_id=$1",
        [abandoned!.work_id],
      );

      assert.equal(
        await processOnce(f.pool, registry, "worker-after-restart", 60),
        true,
      );
      const resumedWork = (
        await f.pool.query<{ work_status: string; attempt_count: number; lease_owner: string | null }>(
          "SELECT work_status,attempt_count,lease_owner FROM analytics.analytics_projection_work WHERE reporting_scope_id=$1",
          [resumedScope],
        )
      ).rows[0]!;
      assert.deepEqual(resumedWork, {
        work_status: "completed",
        attempt_count: 2,
        lease_owner: null,
      });
      assert.ok(
        BigInt(await scalar(
          f.pool,
          "SELECT count(*) FROM analytics.analytics_projection_contribution WHERE source_scope_id=$1",
          [resumedScope],
        ) as string) > 0n,
      );
    } finally {
      await f.close();
    }
  },
);
test(
  "projection ancestor/timezone buckets and observation values use source SQL and preserve bigint timezone revisions",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture();
    try {
      const registry = await loadRegistry(),
        workspace = await scope(
          f.pool,
          "tenant_workspace",
          "tenant-platform",
          "projection-workspace",
          "Africa/Johannesburg",
        ),
        client = await scope(
          f.pool,
          "tenant_client",
          "tenant-platform",
          "projection-client",
          "Africa/Johannesburg",
          workspace,
        );
      const id = await event(
        f.pool,
        "agent-completed",
        "agent.run.completed@1",
        client,
        workspace,
        {
          installation_id: "installation",
          agent_definition_id: "definition",
          agent_version_id: "version",
          status: "completed",
          outcome: "success",
        },
        undefined,
        "agent-platform",
        "agents",
      );
      await enqueue(f.pool, client, workspace, id);
      await processOnce(f.pool, registry, "fixture-ancestor", 60);
      const rows = (
        await f.pool.query(
          `SELECT target_scope_id,timeZone_name AS timezone_name,timezone_revision,bucket_start,bucket_end FROM analytics.analytics_projection_rollup WHERE metric_key='agent.runs.completed' AND interval='day' ORDER BY target_scope_id`,
        )
      ).rows;
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((r) => BigInt(r.target_scope_id)),
        [workspace, client],
      );
      for (const row of rows) {
        assert.equal(row.timezone_name, "Africa/Johannesburg");
        assert.equal(row.timezone_revision, "1788020091680");
        assert.equal(row.bucket_start.toISOString(), "2026-08-22T22:00:00Z");
        assert.equal(row.bucket_end.toISOString(), "2026-08-23T22:00:00Z");
      }
      const observed = BigInt(
        (await scalar(
          f.pool,
          `INSERT INTO analytics.analytics_metric_observation(producer_id,source_service,source_domain,source_stream_key,source_sequence,observation_id,schema_version,reporting_scope_id,root_scope_id,provider,metric_key,numeric_value,unit,reporting_window_start,reporting_window_end,observed_at,synchronization_run_id,dimensions,payload_hash) VALUES('agent-platform-customer-analytics','agent-platform','agents','observation',1,'observation',1,$1,$2,'fixture','agent.tokens.input',321,'tokens','2026-08-23T01:00:00Z','2026-08-23T02:00:00Z','2026-08-23T02:00:00Z','fixture-sync','{}',repeat('b',64)) RETURNING storage_id`,
          [client, workspace],
        )) as string,
      );
      await transaction(f.pool, (tx) =>
        enqueueFact(tx, {
          fact_kind: "observation",
          reporting_scope_id: client,
          root_scope_id: workspace,
          source_storage_id: observed,
          source_window_start: new Date("2026-08-23T01:00:00Z"),
          source_window_end: new Date("2026-08-23T02:00:00Z"),
        }),
      );
      await processOnce(f.pool, registry, "fixture-observation", 60);
      assert.equal(
        await scalar(
          f.pool,
          `SELECT value_sum::double precision FROM analytics.analytics_projection_rollup WHERE metric_key='agent.tokens.input' AND interval='hour' AND target_scope_id=$1`,
          [workspace],
        ),
        321,
      );
    } finally {
      await f.close();
    }
  },
);
