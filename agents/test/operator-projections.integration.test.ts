import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { acknowledgeOperatorNotification, getOperatorProjection, listOperatorNotifications, rebuildOperatorProjections } from "../src/http/operator-projections";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("operator projections (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const eventKey = `projection-test:${randomUUID()}`;
  let notificationId = "";

  it("rebuilds snapshots with monotonic revisions and acknowledges safe notifications", async () => {
    const first = await rebuildOperatorProjections(pool, ["summary", "health", "delivery_health", "alerts", "projection_lag"]);
    expect(first.map((projection) => projection.projectionKey)).toEqual(["summary", "health", "delivery_health", "alerts", "projection_lag"]);
    expect(first.find((projection) => projection.projectionKey === "delivery_health")?.payload).toEqual(expect.objectContaining({ deliveries: expect.any(Object), failedAttempts: expect.any(Array) }));
    expect(first.find((projection) => projection.projectionKey === "alerts")?.payload).toEqual(expect.objectContaining({
      providerFailuresLast24h: expect.any(Object),
      queuedRunsOver15m: expect.any(Number),
      credentialRevocationsLast24h: expect.any(Number),
      dataAccessEventsLast24h: expect.any(Number),
    }));
    const second = await rebuildOperatorProjections(pool, ["summary"]);
    expect(second[0]?.revision).toBe(Number(first[0]?.revision) + 1);
    expect((await getOperatorProjection(pool, "summary")).revision).toBe(second[0]?.revision);

    await pool.query("INSERT INTO agent_operator_notifications (event_key, severity, kind, title, body) VALUES ($1, 'warning', 'test', 'Projection test', 'Safe test notification')", [eventKey]);
    const listed = await listOperatorNotifications(pool);
    const notification = listed.find((entry) => entry.eventKey === eventKey);
    expect(notification).toMatchObject({ eventKey, status: "unread" });
    notificationId = String(notification?.id);
    expect(await acknowledgeOperatorNotification(pool, notificationId)).toMatchObject({ id: notificationId, status: "acknowledged" });
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_operator_notifications WHERE event_key = $1", [eventKey]);
    await pool.end();
  });
});
