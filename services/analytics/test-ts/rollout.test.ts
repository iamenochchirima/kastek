import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { analyticsFixture } from "./database-fixture.js";
import { transaction } from "../src-ts/db.js";
import { apiJson } from "../src-ts/json.js";
import { canonicalJson, serdeFloat } from "@kasitek/server-support/json";
import {
  RolloutDecisionCache,
  decisionCacheKey,
  evaluateCandidates,
  normalizeMutation,
  stableCohortEnabled,
  upsertTransaction,
  evaluateTransaction,
  closeExpiredTransaction,
  parseRolloutMutation,
  type StoredControl,
  type RolloutMutationRequest,
} from "../src-ts/rollout.js";
const enabled = !!process.env.ANALYTICS_TEST_DATABASE_URL;
const actor = {
  source_service: "core",
  producer_id: "core-customer-analytics",
};
const request = (
  overrides: Partial<RolloutMutationRequest> = {},
): RolloutMutationRequest => ({
  control_key: "report",
  control_kind: "rollout",
  target: { kind: "global", key: "global" },
  enabled: true,
  percentage_basis_points: null,
  reason: "fixture approval",
  issue_ref: "fixture",
  expires_at: null,
  remove: false,
  ...overrides,
});
test("rollout default deny, target precedence, cohorts and expiry-sensitive cache", async () => {
  assert.equal(evaluateCandidates("report", "rollout", {}, []).allowed, false);
  assert.equal(evaluateCandidates("ingest", "rollout", {}, []).allowed, true);
  assert.equal(
    evaluateCandidates("report", "kill_switch", {}, []).allowed,
    true,
  );
  const global: StoredControl = {
    control_id: 1n,
    control_key: "report",
    control_kind: "rollout",
    target_kind: "global",
    target_key: "global",
    enabled: true,
    percentage_basis_points: null,
    revision: 1n,
    expires_at: null,
    removed_at: null,
  };
  const scoped = {
    ...global,
    control_id: 2n,
    target_kind: "reporting_scope" as const,
    target_key: "9007199254740993",
    enabled: false,
    revision: 2n,
  };
  assert.equal(
    evaluateCandidates(
      "report",
      "rollout",
      { reporting_scope_id: 9007199254740993n },
      [global, scoped],
    ).allowed,
    false,
  );
  assert.equal(stableCohortEnabled("report", "fixture", "cohort", 10000), true);
  assert.equal(stableCohortEnabled("report", "fixture", "cohort", 0), false);
  assert.throws(() =>
    parseRolloutMutation({
      ...request(),
      percentage_basis_points: serdeFloat(1),
    }),
  );
  assert.throws(
    () =>
      normalizeMutation(
        request({
          control_kind: "kill_switch",
          target: { kind: "percentage", key: "fixture" },
        }),
        "2030-01-01T00:00:00Z",
      ),
    /kill switches/,
  );
  const values = new Map<string, string>(),
    ttls: number[] = [];
  const cache = new RolloutDecisionCache({
    async get(key) {
      return values.get(key) ?? null;
    },
    async set(key, value, ttl) {
      values.set(key, value);
      ttls.push(ttl);
    },
  });
  const key = decisionCacheKey(
      "report",
      "rollout",
      { reporting_scope_id: 9007199254740993n },
      2n,
    ),
    decision = {
      ...evaluateCandidates("report", "rollout", {}, [global]),
      registry_revision: 2n,
      expires_at: "2030-01-01T00:00:07.123456Z",
    };
  await cache.write(key, decision, "2030-01-01T00:00:00.123456Z");
  assert.deepEqual(ttls, [7]);
  assert.equal((await cache.read(key, "2030-01-01T00:00:06Z")).kind, "hit");
  assert.equal(
    (await cache.read(key, "2030-01-01T00:00:07.123456Z")).kind,
    "stale",
  );
  values.set(
    key,
    '{"cached_at":"2030-01-01T00:00:00Z","decision":{"registry_revision":1.0}}',
  );
  assert.equal(
    (await cache.read(key, "2030-01-01T00:00:01Z")).kind,
    "unavailable",
  );
  const down = new RolloutDecisionCache({
    async get() {
      throw Error("fixture-outage");
    },
    async set() {
      throw Error("fixture-outage");
    },
  });
  assert.equal(
    (await down.read(key, "2030-01-01T00:00:00Z")).kind,
    "unavailable",
  );
  await down.write(key, decision, "2030-01-01T00:00:00Z");
  assert.equal(
    (await new RolloutDecisionCache().read(key, "2030-01-01T00:00:00Z")).kind,
    "disabled",
  );
});
test(
  "rollout mutation/expiry share immutable audit chain and transaction rollback",
  { skip: !enabled },
  async () => {
    const f = await analyticsFixture();
    try {
      const now = "2030-01-01T00:00:00.123456Z";
      let first: any = await transaction(f.pool, (tx) =>
        upsertTransaction(
          tx,
          actor,
          request({ expires_at: "2030-01-01T00:00:10.123456Z" }),
          now,
          "fixture-correlation",
        ),
      );
      assert.equal(first.revision, 1n);
      assert.equal(
        (
          await transaction(f.pool, (tx) =>
            evaluateTransaction(tx, "report", "rollout", {}, now),
          )
        ).allowed,
        true,
      );
      await assert.rejects(
        transaction(f.pool, async (tx) => {
          await upsertTransaction(tx, actor, request({ enabled: false }), now);
          throw Error("fixture-rollback");
        }),
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT COUNT(*) FROM analytics.analytics_audit_record",
          )
        ).rows[0]!.count,
        "1",
      );
      const expiry = await transaction(f.pool, (tx) =>
        closeExpiredTransaction(
          tx,
          actor,
          "2030-01-01T00:00:11.123456Z",
          "fixture-expiry",
        ),
      );
      assert.equal(expiry.closed_count, 1n);
      assert.equal(
        (
          await transaction(f.pool, (tx) =>
            evaluateTransaction(
              tx,
              "report",
              "rollout",
              {},
              "2030-01-01T00:00:12Z",
            ),
          )
        ).allowed,
        false,
      );
      const audits = (
        await f.pool.query(
          "SELECT * FROM analytics.analytics_audit_record ORDER BY chain_sequence",
        )
      ).rows;
      assert.equal(audits.length, 2);
      assert.equal(audits[1].previous_record_hash, audits[0].record_hash);
      assert.equal(
        audits[0].safe_metadata.expires_at,
        "2030-01-01T00:00:10.123456Z",
      );
      for (const a of audits) {
        const payload = {
          chain_name: a.chain_name,
          previous_record_hash: a.previous_record_hash,
          principal_type: a.principal_type,
          principal_id: a.principal_id,
          reporting_scope_id:
            a.reporting_scope_id === null ? null : BigInt(a.reporting_scope_id),
          permission: a.permission,
          operation: a.operation,
          metric_keys: a.metric_keys,
          request_hash: a.request_hash,
          filter_hash: a.filter_hash,
          outcome: a.outcome,
          correlation_id: a.correlation_id,
          policy_version: a.policy_version,
          safe_metadata: a.safe_metadata,
          occurred_at: a.occurred_at.toISOString(),
          created_at: a.created_at.toISOString(),
        };
        assert.equal(
          createHash("sha256").update(apiJson(payload)).digest("hex"),
          a.record_hash,
        );
      }
      const normalized = request({ expires_at: "2030-01-01T00:00:10.123456Z" });
      assert.equal(
        audits[0].request_hash,
        createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
      );
      assert.equal(
        (
          await transaction(f.pool, (tx) =>
            closeExpiredTransaction(tx, actor, "2030-01-01T00:00:13Z"),
          )
        ).closed_count,
        0n,
      );
    } finally {
      await f.close();
    }
  },
);
