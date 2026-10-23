import { randomUUID } from "node:crypto";
import type pg from "pg";
import type {
  OperationsRule,
  OperationsSnapshot,
  OperationsSignal,
  OperationsNotification,
} from "@kasitek-labs/contracts";
import type { OperationsConfig } from "./config.js";
import { transaction } from "./db.js";
import { defaults, measure, advance, fingerprint } from "./rules.js";
import { rule, type Row } from "./serializers.js";
export async function initialize(
  pool: pg.Pool,
  config: OperationsConfig,
): Promise<void> {
  await transaction(pool, async (c) => {
    const watchdog = {
      id: "operations:monitor.stale",
      source: "operations",
      signalKey: "monitor.stale",
      enabled: true,
      threshold: "180",
      minimumSamples: 0,
      breachCount: 2,
      recoveryCount: 2,
      severity: "critical",
      revision: 1,
    };
    const addedWatch = await c.query(
      "INSERT INTO ops_rules(id,source,signal_key,enabled,threshold,minimum_samples,breach_count,recovery_count,severity) VALUES($1,$2,$3,true,$4,0,2,2,'critical') ON CONFLICT(id) DO NOTHING RETURNING id",
      [watchdog.id, watchdog.source, watchdog.signalKey, watchdog.threshold],
    );
    if (addedWatch.rowCount)
      await c.query(
        "INSERT INTO ops_rule_versions(rule_id,revision,value) VALUES($1,1,$2)",
        [watchdog.id, watchdog],
      );
    const ids = config.sources.map((s) => s.id);
    await c.query(
      "UPDATE ops_monitors SET enabled=false WHERE NOT(id=ANY($1::text[]))",
      [ids],
    );
    for (const s of config.sources) {
      await c.query(
        `INSERT INTO ops_monitors(id,source,origin,enabled,interval_seconds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET source=excluded.source,origin=excluded.origin,enabled=excluded.enabled,interval_seconds=excluded.interval_seconds`,
        [s.id, s.source, s.origin, s.enabled, s.intervalSeconds],
      );
      for (const r of defaults(s.source)) {
        const added = await c.query(
          `INSERT INTO ops_rules(id,source,signal_key,enabled,threshold,minimum_samples,breach_count,recovery_count,severity) VALUES($1,$2,$3,true,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING RETURNING *`,
          [
            r.id,
            r.source,
            r.signalKey,
            r.threshold,
            r.minimumSamples,
            r.breachCount,
            r.recoveryCount,
            r.severity,
          ],
        );
        if (added.rows[0])
          await c.query(
            "INSERT INTO ops_rule_versions(rule_id,revision,value) VALUES($1,1,$2)",
            [r.id, rule(added.rows[0])],
          );
      }
    }
  });
}
export interface Claim {
  id: string;
  source: string;
  origin: string;
  fence: string;
  interval_seconds: number;
}
export async function claimMonitors(
  pool: pg.Pool,
  now: Date,
  limit = 4,
): Promise<Claim[]> {
  return transaction(pool, async (c) => {
    await c.query(
      "SELECT pg_advisory_xact_lock(hashtext('operations-collection-capacity'))",
    );
    const active = Number(
      (
        await c.query(
          "SELECT count(*)::int count FROM ops_monitors WHERE lease_until>$1",
          [now],
        )
      ).rows[0].count,
    );
    const capacity = Math.max(0, Math.min(4 - active, limit));
    if (!capacity) return [];
    const r = await c.query(
      `WITH due AS(SELECT id FROM ops_monitors WHERE enabled AND next_poll_at<=$1 AND (lease_until IS NULL OR lease_until<$1) ORDER BY next_poll_at,id FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE ops_monitors m SET fence=m.fence+1,lease_until=$1::timestamptz+interval '30 seconds' FROM due WHERE m.id=due.id RETURNING m.id,m.source,m.origin,m.fence::text,m.interval_seconds`,
      [now, capacity],
    );
    return r.rows;
  });
}
export async function audit(
  c: pg.PoolClient,
  environment: string,
  actor: string | null,
  action: string,
  status: string,
  type: string,
  id: string,
  operationId: string | null = null,
  code: string | null = null,
): Promise<void> {
  await c.query(
    "INSERT INTO ops_audit(id,environment,actor_id,action,status,resource_type,resource_id,operation_id,code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      randomUUID(),
      environment,
      actor,
      action,
      status,
      type,
      id,
      operationId,
      code,
    ],
  );
}
export async function emitTransition(
  c: pg.PoolClient,
  config: OperationsConfig,
  row: Row,
  action: string,
  actor: string | null,
  reason: string | null,
  now: Date,
): Promise<void> {
  const transitionId = randomUUID();
  await c.query(
    "INSERT INTO ops_transitions(id,incident_id,action,actor_id,reason,created_at,revision) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [transitionId, row.id, action, actor, reason, now, row.revision],
  );
  await audit(
    c,
    config.environment,
    actor,
    `incident.${action}`,
    "succeeded",
    "incident",
    row.id,
  );
  if (!["opened", "escalated", "assigned", "resolved"].includes(action)) return;
  const recipients = (
    await c.query(
      "SELECT admin_id FROM operations.admin_principals WHERE active=true ORDER BY admin_id LIMIT 1000",
    )
  ).rows.map((r) => r.admin_id as string);
  if (!recipients.length) return;
  const payload: OperationsNotification = {
    id: transitionId,
    incidentId: row.id,
    transition: action as OperationsNotification["transition"],
    severity: action === "resolved" ? "info" : row.severity,
    recipients,
    title:
      action === "resolved"
        ? "Incident recovered"
        : action === "assigned"
          ? "Incident assigned"
          : action === "escalated"
            ? "Incident escalated"
            : "Incident detected",
    message: `${row.source}: ${row.signal_key}`,
    link: `/operations/incidents/${row.id}`,
  };
  await c.query(
    "INSERT INTO ops_outbox(id,incident_id,transition_id,payload,created_at) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), row.id, transitionId, payload, now],
  );
}
export async function evaluateSignal(
  c: pg.PoolClient,
  config: OperationsConfig,
  r: OperationsRule,
  signal: OperationsSignal,
  observedAt: Date,
  observationId: string | null,
): Promise<void> {
  if (!r.enabled) return;
  const fp = fingerprint(
    config.environment,
    r.source,
    r.signalKey,
    signal.group,
  );
  await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [fp]);
  const old = (
    await c.query(
      "SELECT * FROM ops_conditions WHERE fingerprint=$1 FOR UPDATE",
      [fp],
    )
  ).rows[0];
  if (old && new Date(old.last_observed_at) >= observedAt) return;
  const condition = measure(r, signal),
    counts = advance(
      old
        ? {
            breaches: old.breach_count,
            recoveries: old.recovery_count,
            revision: old.rule_revision,
          }
        : null,
      condition,
      r.revision,
    );
  await c.query(
    `INSERT INTO ops_conditions(fingerprint,rule_id,group_key,last_observed_at,breach_count,recovery_count,condition,rule_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(fingerprint) DO UPDATE SET last_observed_at=excluded.last_observed_at,breach_count=excluded.breach_count,recovery_count=excluded.recovery_count,condition=excluded.condition,rule_revision=excluded.rule_revision`,
    [
      fp,
      r.id,
      signal.group,
      observedAt,
      counts.breaches,
      counts.recoveries,
      condition,
      r.revision,
    ],
  );
  let active = (
    await c.query(
      "SELECT * FROM ops_incidents WHERE fingerprint=$1 AND status<>'resolved' FOR UPDATE",
      [fp],
    )
  ).rows[0];
  if (!active && condition === "breached" && counts.breaches >= r.breachCount) {
    const previous = (
      await c.query(
        "SELECT id FROM ops_incidents WHERE fingerprint=$1 ORDER BY opened_at DESC LIMIT 1",
        [fp],
      )
    ).rows[0];
    active = (
      await c.query(
        `INSERT INTO ops_incidents(id,fingerprint,environment,source,signal_key,group_key,severity,status,condition,opened_at,updated_at,previous_incident_id,evidence,value,rule_revision,observed_at,observation_id) VALUES($1,$2,$3,$4,$5,$6,$7,'open',$8,$9,$9,$10,$11,$12,$13,$9,$14) RETURNING *`,
        [
          randomUUID(),
          fp,
          config.environment,
          r.source,
          r.signalKey,
          signal.group,
          r.severity,
          condition,
          observedAt,
          previous?.id ?? null,
          JSON.stringify(signal.evidence),
          signal.value,
          r.revision,
          observationId,
        ],
      )
    ).rows[0];
    await emitTransition(c, config, active!, "opened", null, null, observedAt);
    return;
  }
  if (!active) return;
  let action: string | null = null;
  if (condition === "healthy" && counts.recoveries >= r.recoveryCount)
    action = "resolved";
  else if (
    r.severity === "critical" &&
    active.severity === "warning" &&
    condition === "breached"
  )
    action = "escalated";
  const updated = (
    await c.query(
      `UPDATE ops_incidents SET condition=$2,evidence=$3,value=$4,rule_revision=$5,observed_at=$6,observation_id=$7,updated_at=$6,severity=CASE WHEN $8='escalated' THEN 'critical' ELSE severity END,status=CASE WHEN $8='resolved' THEN 'resolved' ELSE status END,resolved_at=CASE WHEN $8='resolved' THEN $6 ELSE resolved_at END,revision=revision+CASE WHEN $8::text IS NULL THEN 0 ELSE 1 END WHERE id=$1 RETURNING *`,
      [
        active.id,
        condition,
        JSON.stringify(signal.evidence),
        signal.value,
        r.revision,
        observedAt,
        observationId,
        action,
      ],
    )
  ).rows[0];
  if (action)
    await emitTransition(c, config, updated!, action, null, null, observedAt);
}
export async function completeObservation(
  pool: pg.Pool,
  config: OperationsConfig,
  claim: Claim,
  snapshot: OperationsSnapshot,
  error: string | null,
  now: Date,
  jitter = 0.05,
): Promise<boolean> {
  return transaction(pool, async (c) => {
    const m = (
      await c.query("SELECT * FROM ops_monitors WHERE id=$1 FOR UPDATE", [
        claim.id,
      ])
    ).rows[0];
    if (
      !m ||
      String(m.fence) !== claim.fence ||
      !m.lease_until ||
      new Date(m.lease_until) <= now
    )
      return false;
    const observedAt = new Date(snapshot.observedAt);
    if (m.last_observed_at && observedAt <= new Date(m.last_observed_at)) {
      await c.query(
        "UPDATE ops_monitors SET lease_until=NULL,next_poll_at=$2::timestamptz+interval '60 seconds',last_error='late_observation',last_completed_at=$2 WHERE id=$1",
        [claim.id, now],
      );
      return false;
    }
    const saved = (
      await c.query(
        "INSERT INTO ops_observations(monitor_id,observed_at,received_at,snapshot,error_code) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
        [claim.id, observedAt, now, snapshot, error],
      )
    ).rows[0];
    if (!saved) return false;
    const next = new Date(
      now.getTime() +
        claim.interval_seconds *
          1000 *
          (1 + Math.max(-0.1, Math.min(0.1, jitter))),
    );
    await c.query(
      "UPDATE ops_monitors SET last_observed_at=$2,last_completed_at=$3,last_error=$4,lease_until=NULL,next_poll_at=$5 WHERE id=$1",
      [claim.id, observedAt, now, error, next],
    );
    if (config.evaluationEnabled) {
      for (const s of snapshot.signals.filter(
        (s) =>
          /^worker\.[a-z0-9_-]+\.age_seconds$/.test(s.key) &&
          s.expectedIntervalSeconds,
      )) {
        const id = `${claim.source}:${s.key}`;
        const inserted = (
          await c.query(
            "INSERT INTO ops_rules(id,source,signal_key,enabled,threshold,minimum_samples,breach_count,recovery_count,severity) VALUES($1,$2,$3,true,$4,0,2,2,'warning') ON CONFLICT(id) DO NOTHING RETURNING *",
            [id, claim.source, s.key, String(s.expectedIntervalSeconds! * 3)],
          )
        ).rows[0];
        if (inserted)
          await c.query(
            "INSERT INTO ops_rule_versions(rule_id,revision,value) VALUES($1,1,$2)",
            [id, rule(inserted)],
          );
      }
      const rules = (
        await c.query("SELECT * FROM ops_rules WHERE source=$1", [claim.source])
      ).rows.map(rule);
      for (const r of rules) {
        const selected = snapshot.signals.filter((s) => s.key === r.signalKey);
        if (!selected.length)
          selected.push({
            key: r.signalKey,
            group: "fleet",
            status: "unknown",
            coverage: "unknown",
            value: null,
            unit: "count",
            evidence: [],
            code: "missing_signal",
          });
        for (const s of selected)
          await evaluateSignal(c, config, r, s, observedAt, String(saved.id));
      }
    }
    return true;
  });
}
export async function expireStaleEvidence(
  pool: pg.Pool,
  now: Date,
): Promise<void> {
  await pool.query(
    "UPDATE ops_incidents SET condition='unknown' WHERE status<>'resolved' AND observed_at<$1::timestamptz-interval '180 seconds' AND condition<>'unknown'",
    [now],
  );
}
export async function retention(pool: pg.Pool, now: Date): Promise<void> {
  await transaction(pool, async (c) => {
    await c.query(
      `DELETE FROM ops_observations WHERE id IN(SELECT o.id FROM ops_observations o WHERE received_at<$1::timestamptz-interval '30 days' AND NOT EXISTS(SELECT 1 FROM ops_incidents i WHERE i.observation_id=o.id) ORDER BY o.id LIMIT 500)`,
      [now],
    );
    await c.query(
      "DELETE FROM ops_audit WHERE id IN(SELECT id FROM ops_audit WHERE occurred_at<$1::timestamptz-interval '90 days' ORDER BY occurred_at LIMIT 500)",
      [now],
    );
    await c.query(
      "DELETE FROM ops_commands WHERE operation_id IN(SELECT operation_id FROM ops_commands WHERE created_at<$1::timestamptz-interval '90 days' ORDER BY created_at LIMIT 500)",
      [now],
    );
  });
}
export async function watchdog(
  pool: pg.Pool,
  config: OperationsConfig,
  now = new Date(),
): Promise<void> {
  await expireStaleEvidence(pool, now);
  if (!config.collectionEnabled || !config.evaluationEnabled) return;
  await transaction(pool, async (c) => {
    const rrow = (
      await c.query(
        "SELECT * FROM ops_rules WHERE id='operations:monitor.stale'",
      )
    ).rows[0];
    if (!rrow) return;
    const r = rule(rrow),
      monitors = (
        await c.query(
          "SELECT * FROM ops_monitors WHERE enabled ORDER BY id LIMIT 100",
        )
      ).rows;
    for (const m of monitors) {
      const base = new Date(m.last_completed_at ?? m.next_poll_at);
      const age = Math.max(
        0,
        Math.floor((now.getTime() - base.getTime()) / 1000),
      );
      await evaluateSignal(
        c,
        config,
        {
          ...r,
          threshold: String(
            Math.max(Number(r.threshold), m.interval_seconds * 3),
          ),
        },
        {
          key: "monitor.stale",
          group: m.id,
          status: "available",
          coverage: "complete",
          value: String(age),
          unit: "seconds",
          evidence: [],
        },
        now,
        null,
      );
    }
  });
}
