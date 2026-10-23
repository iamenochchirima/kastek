import type pg from "pg";
import { randomUUID, createHash } from "node:crypto";
import type { OperationsSnapshot } from "@kasitek-labs/contracts";
import {
  createOperationsServiceAuthority,
  OPERATIONS_AUTHORITY_HEADER,
} from "@kasitek-labs/server-support/operations-authority";
import { readOperationsSnapshot } from "@kasitek-labs/server-support/operations-signals";
import type { OperationsConfig, Source } from "./config.js";
import {
  claimMonitors,
  completeObservation,
  expireStaleEvidence,
  retention,
  type Claim,
} from "./engine.js";
import { recordCollection, recordDelivery, operationLog } from "./telemetry.js";
export async function collect(
  pool: pg.Pool,
  config: OperationsConfig,
  claim: Claim,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const source = config.sources.find((s) => s.id === claim.id);
  if (!source) return false;
  let snapshot: OperationsSnapshot,
    error: string | null = null;
  try {
    const path = "/internal/operations/signals";
    const authority = createOperationsServiceAuthority({
      secret: source.secret,
      audience: source.source,
      scope: "signals:read",
      environment: config.environment,
      method: "GET",
      path,
    });
    const response = await fetcher(source.origin + path, {
      headers: { [OPERATIONS_AUTHORITY_HEADER]: authority },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403)
      throw new Error("source_unauthorized");
    if (!response.ok) throw new Error("source_http_failure");
    try {
      snapshot = await readOperationsSnapshot(
        response,
        source.source,
        config.environment,
      );
    } catch {
      throw new Error("source_incompatible");
    }
    const skew = Date.parse(snapshot.observedAt) - now.getTime();
    if (skew > 30000 || skew < -180000)
      throw new Error("source_clock_or_stale");
    if (!snapshot.signals.some((s) => s.key === "source.available"))
      snapshot.signals.unshift({
        key: "source.available",
        group: "fleet",
        status: "available",
        coverage: "complete",
        value: "1",
        unit: "count",
        evidence: [],
      });
  } catch (e) {
    error =
      e instanceof Error &&
      [
        "source_unauthorized",
        "source_http_failure",
        "source_incompatible",
        "source_clock_or_stale",
      ].includes(e.message)
        ? e.message
        : "source_transport_failure";
    snapshot = {
      contractVersion: "1",
      source: claim.source as Source,
      environment: config.environment,
      observedAt: now.toISOString(),
      release: "observer",
      signals: [
        {
          key: "source.available",
          group: "fleet",
          status: "available",
          coverage: "complete",
          value: "0",
          unit: "count",
          evidence: [],
          code: error,
        },
      ],
    };
  }
  const accepted = await completeObservation(
    pool,
    config,
    claim,
    snapshot,
    error,
    new Date(),
    Math.random() * 0.2 - 0.1,
  );
  recordCollection(
    claim.source,
    !accepted ? "fenced" : error ? "failed" : "success",
  );
  operationLog(config, "collection_completed", {
    source: claim.source,
    code: !accepted ? "stale_lease_or_observation" : (error ?? "collected"),
  });
  return accepted;
}
export async function deliverNotifications(
  pool: pg.Pool,
  config: OperationsConfig,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (
    !config.notificationsEnabled ||
    !config.notificationOrigin ||
    !config.notificationSecret
  )
    return 0;
  const claimed = await pool.query(
    `WITH due AS(SELECT id FROM ops_outbox WHERE delivered_at IS NULL AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<$1) ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 4) UPDATE ops_outbox o SET lease_until=$1::timestamptz+interval '30 seconds',fence=o.fence+1 FROM due WHERE o.id=due.id RETURNING o.*`,
    [now],
  );
  let delivered = 0;
  await Promise.all(
    claimed.rows.map(async (row) => {
      try {
        const suppression = await pool.query(
          "SELECT 1 FROM ops_maintenance m JOIN ops_incidents i ON i.id=$1 WHERE m.expired_at IS NULL AND m.starts_at<=$2 AND m.ends_at>$2 AND (m.source IS NULL OR m.source=i.source) AND (m.rule_id IS NULL OR m.rule_id=i.source ||':'||i.signal_key) LIMIT 1",
          [row.incident_id, now],
        );
        if (suppression.rowCount) {
          await pool.query(
            "UPDATE ops_outbox SET lease_until=NULL,next_attempt_at=$3::timestamptz+interval '60 seconds' WHERE id=$1 AND fence=$2",
            [row.id, row.fence, now],
          );
          return;
        }
        const superseded = await pool.query(
          `SELECT 1 FROM ops_outbox later JOIN ops_transitions lt ON lt.id=later.transition_id JOIN ops_transitions current ON current.id=$2 WHERE later.incident_id=$1 AND lt.revision>current.revision LIMIT 1`,
          [row.incident_id, row.transition_id],
        );
        const original = row.payload.recipients as string[],
          outcomes: Record<string, string> = { ...row.recipient_outcomes };
        const active = new Set(
          (
            await pool.query(
              "SELECT admin_id FROM operations.admin_principals WHERE active=true AND admin_id=ANY($1::text[])",
              [original],
            )
          ).rows.map((r) => r.admin_id),
        );
        for (const id of original)
          if (!outcomes[id] && (superseded.rowCount || !active.has(id)))
            outcomes[id] = "suppressed";
        const recipient = original.find((id) => !outcomes[id]);
        if (recipient) {
          // The request identity and body never depend on another recipient's grant.
          const id = createHash("sha256")
            .update(JSON.stringify([row.payload.id, recipient]))
            .digest("hex");
          const payload = { ...row.payload, id, recipients: [recipient] },
            path = "/internal/operations/notifications",
            body = JSON.stringify(payload);
          const authority = createOperationsServiceAuthority({
            secret: config.notificationSecret!,
            audience: "growth",
            scope: "notifications:publish",
            environment: config.environment,
            method: "POST",
            path,
            body,
          });
          const response = await fetcher(config.notificationOrigin + path, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [OPERATIONS_AUTHORITY_HEADER]: authority,
            },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
          const success = response.ok;
          await response.body?.cancel();
          if (!success) throw new Error("notification_unavailable");
          outcomes[recipient] = "delivered";
          recordDelivery("delivered");
          delivered++;
        }
        const complete = original.every((id) => !!outcomes[id]),
          allSuppressed = original.every((id) => outcomes[id] === "suppressed");
        await pool.query(
          `UPDATE ops_outbox SET recipient_outcomes=$4,lease_until=NULL,attempts=attempts+1,next_attempt_at=$3::timestamptz+interval '1 second',delivered_at=CASE WHEN $5 THEN $3 ELSE NULL END,disposition=CASE WHEN NOT $5 THEN 'pending' WHEN $6 THEN 'suppressed' ELSE 'delivered' END WHERE id=$1 AND fence=$2 AND lease_until>$3`,
          [row.id, row.fence, new Date(), outcomes, complete, allSuppressed],
        );
        if (complete && allSuppressed) recordDelivery("suppressed");
      } catch {
        recordDelivery("failed");
        await pool.query(
          "UPDATE ops_outbox SET lease_until=NULL,attempts=attempts+1,next_attempt_at=$3 WHERE id=$1 AND fence=$2",
          [
            row.id,
            row.fence,
            new Date(
              now.getTime() +
                Math.min(3600, 15 * 2 ** Math.min(row.attempts, 8)) * 1000,
            ),
          ],
        );
      }
    }),
  );
  return delivered;
}
export async function workerTick(
  pool: pg.Pool,
  config: OperationsConfig,
  id: string,
  now = new Date(),
): Promise<void> {
  await pool.query(
    "INSERT INTO ops_worker_progress(id,updated_at) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at",
    [id, now],
  );
  if (config.collectionEnabled) {
    const claims = await claimMonitors(pool, now);
    await Promise.all(claims.map((c) => collect(pool, config, c, now)));
  }
  await deliverNotifications(pool, config, now);
  await expireStaleEvidence(pool, now);
}
export async function runWorker(
  pool: pg.Pool,
  config: OperationsConfig,
  signal: AbortSignal,
): Promise<void> {
  const id = randomUUID();
  let retentionAt = 0;
  while (!signal.aborted) {
    const started = Date.now();
    try {
      await workerTick(pool, config, id);
      if (Date.now() > retentionAt) {
        await retention(pool, new Date());
        retentionAt = Date.now() + 3600000;
      }
    } catch {
      console.error(
        JSON.stringify({
          service: "operations-worker",
          environment: config.environment,
          event: "worker_tick_failed",
          code: "database_or_collection_error",
        }),
      );
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(
        done,
        Math.max(1000, 5000 - (Date.now() - started)),
      );
      signal.addEventListener("abort", done, { once: true });
    });
  }
}
