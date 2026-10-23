import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate-main.js";
import {
  initialize,
  claimMonitors,
  completeObservation,
  retention,
  watchdog,
} from "../src/engine.js";
import { deliverNotifications, collect } from "../src/worker.js";
import { buildApi } from "../src/api.js";
import { loadConfig } from "../src/config.js";
import { measure, advance, defaults } from "../src/rules.js";
import type { OperationsSnapshot } from "@kasitek-labs/contracts";
const database = process.env.OPERATIONS_TEST_DATABASE_URL;
const baseEnv = {
  DATABASE_URL: database,
  OPS_ENVIRONMENT: "test",
  OPS_SOURCES_JSON: JSON.stringify([
    {
      id: "growth",
      source: "growth",
      origin: "http://127.0.0.1:12345",
      secret: "o".repeat(32),
      enabled: true,
      intervalSeconds: 10,
    },
  ]),
  OPS_COLLECTION_ENABLED: "true",
  OPS_EVALUATION_ENABLED: "true",
};
const sample = (
  at: Date,
  value = "0",
  availability = "1",
): OperationsSnapshot => ({
  contractVersion: "1",
  source: "growth",
  environment: "test",
  observedAt: at.toISOString(),
  release: "fixture",
  signals: [
    {
      key: "source.available",
      group: "fleet",
      status: "available",
      value: availability,
      unit: "count",
      coverage: "complete",
      evidence: [],
    },
    {
      key: "publication.quarantined",
      group: "fleet",
      status: "available",
      value,
      unit: "count",
      coverage: "complete",
      evidence: [],
    },
  ],
});
test("pure classification preserves unknown, exact thresholds, samples and hysteresis", () => {
  const r = defaults("growth").find(
      (r) => r.signalKey === "execution.failure_rate_bps",
    )!,
    s = {
      key: r.signalKey,
      group: "fleet",
      status: "available" as const,
      value: "2000",
      unit: "basis_points" as const,
      coverage: "complete" as const,
      evidence: [],
      denominator: "20",
    };
  assert.equal(measure(r, s), "breached");
  assert.equal(measure(r, { ...s, denominator: "19" }), "unknown");
  assert.equal(measure(r, { ...s, coverage: "partial" }), "unknown");
  assert.equal(measure(r, { ...s, status: "unsupported" }), "unknown");
  assert.equal(measure(r, { ...s, status: "no_activity" }), "healthy");
  assert.equal(
    measure(r, { ...s, status: "no_activity", denominator: "0" }),
    "unknown",
    "insufficient samples cannot recover an existing rate incident",
  );
  assert.deepEqual(
    advance({ breaches: 4, recoveries: 0, revision: 1 }, "unknown", 1),
    { breaches: 0, recoveries: 0 },
  );
  assert.deepEqual(
    advance({ breaches: 4, recoveries: 0, revision: 1 }, "breached", 2),
    { breaches: 1, recoveries: 0 },
  );
  assert.throws(() =>
    loadConfig({
      ...baseEnv,
      DATABASE_URL: "postgres://x",
      OPS_SOURCES_JSON: JSON.stringify([
        {
          id: "growth",
          source: "growth",
          origin: "http://example.com",
          secret: "x".repeat(32),
        },
      ]),
    }),
  );
});
test(
  "durable collection, leases, episodes, maintenance, delivery, API auth and retention",
  { skip: !database },
  async () => {
    assert.match(
      new URL(database!).pathname,
      /test/,
      "Only explicitly named test database allowed",
    );
    await migrate(database!);
    const checksumPool = createPool(database!);
    const savedChecksum = (
      await checksumPool.query(
        "SELECT checksum FROM ops_migrations WHERE name='003_delivery_retention.sql'",
      )
    ).rows[0].checksum;
    await checksumPool.query(
      "UPDATE ops_migrations SET checksum='invalid' WHERE name='003_delivery_retention.sql'",
    );
    try {
      await assert.rejects(() => migrate(database!), /checksum differs/);
    } finally {
      await checksumPool.query(
        "UPDATE ops_migrations SET checksum=$1 WHERE name='003_delivery_retention.sql'",
        [savedChecksum],
      );
      await checksumPool.end();
    }
    const pool = createPool(database!),
      config = loadConfig(baseEnv);
    const tables = [
      "ops_commands",
      "ops_audit",
      "ops_outbox",
      "ops_transitions",
      "ops_incidents",
      "ops_conditions",
      "ops_observations",
      "ops_maintenance",
      "ops_rule_versions",
      "ops_rules",
      "ops_worker_progress",
      "ops_monitors",
    ];
    try {
      await pool.query(`TRUNCATE ${tables.join(",")} CASCADE`);
      await pool.query("TRUNCATE operations.admin_principals CASCADE");
      await pool.query(
        "INSERT INTO operations.admin_principals(admin_id,issuer,subject,role,name,email) VALUES('operator','http://127.0.0.1:12345','subject','owner','Operator','operator@example.test')",
      );
      await initialize(pool, config);
      const future = new Date(Date.now() + 5000);
      let now = new Date(future);
      async function observe(
        snapshot: OperationsSnapshot,
        error: string | null = null,
      ) {
        await pool.query("UPDATE ops_monitors SET next_poll_at=$1", [now]);
        const claims = await claimMonitors(pool, now);
        assert.equal(claims.length, 1);
        assert.equal(
          await completeObservation(
            pool,
            config,
            claims[0]!,
            snapshot,
            error,
            now,
            0,
          ),
          true,
        );
        now = new Date(now.getTime() + 11000);
      }
      const initial = (await claimMonitors(pool, now))[0]!;
      assert.ok(initial);
      assert.equal(
        (await claimMonitors(pool, now)).length,
        0,
        "second worker cannot overlap lease",
      );
      await pool.query("UPDATE ops_monitors SET lease_until=$1", [
        new Date(now.getTime() - 1),
      ]);
      const successor = (await claimMonitors(pool, now))[0]!;
      assert.notEqual(initial.fence, successor.fence);
      assert.equal(
        await completeObservation(pool, config, initial, sample(now), "", now),
        false,
        "stale fence rejected",
      );
      await completeObservation(
        pool,
        config,
        successor,
        sample(now),
        null,
        now,
      );
      now = new Date(now.getTime() + 11000);
      const heartbeatSnapshot = sample(now, "1");
      heartbeatSnapshot.signals.push({
        key: "worker.publisher.fixture.age_seconds",
        group: "workers",
        status: "unknown",
        coverage: "unknown",
        value: null,
        unit: "seconds",
        evidence: [],
        expectedIntervalSeconds: 30,
      });
      await observe(heartbeatSnapshot);
      assert.equal(
        (
          await pool.query(
            "SELECT threshold FROM ops_rules WHERE id='growth:worker.publisher.fixture.age_seconds'",
          )
        ).rows[0].threshold,
        "90",
      );
      assert.equal(
        (await pool.query("SELECT count(*) FROM ops_incidents")).rows[0].count,
        "0",
      );
      await observe(sample(now, "1"));
      let active = (
        await pool.query("SELECT * FROM ops_incidents WHERE status<>'resolved'")
      ).rows[0];
      assert.equal(active.signal_key, "publication.quarantined");
      const first = active.id;
      assert.equal(
        (await pool.query("SELECT count(*) FROM ops_outbox")).rows[0].count,
        "1",
      );
      await observe(sample(now, "1"));
      assert.equal(
        (await pool.query("SELECT count(*) FROM ops_incidents")).rows[0].count,
        "1",
      );
      const unknown = sample(now);
      unknown.signals[1]!.status = "unknown";
      unknown.signals[1]!.value = null;
      unknown.signals[1]!.coverage = "unknown";
      await observe(unknown);
      assert.equal(
        (
          await pool.query(
            "SELECT condition,status FROM ops_incidents WHERE id=$1",
            [first],
          )
        ).rows[0].condition,
        "unknown",
      );
      await observe(sample(now));
      assert.equal(
        (
          await pool.query("SELECT status FROM ops_incidents WHERE id=$1", [
            first,
          ])
        ).rows[0].status,
        "open",
      );
      await observe(sample(now));
      assert.equal(
        (
          await pool.query("SELECT status FROM ops_incidents WHERE id=$1", [
            first,
          ])
        ).rows[0].status,
        "resolved",
      );
      await observe(sample(now, "1"));
      await observe(sample(now, "1"));
      active = (
        await pool.query("SELECT * FROM ops_incidents WHERE status<>'resolved'")
      ).rows[0];
      assert.equal(active.previous_incident_id, first);
      const maintenanceId = randomUUID();
      await pool.query(
        "INSERT INTO ops_maintenance(id,source,starts_at,ends_at,reason,actor_id) VALUES($1,'growth',$2,$3,'Fixture maintenance','operator')",
        [
          maintenanceId,
          new Date(now.getTime() - 1000),
          new Date(now.getTime() + 600000),
        ],
      );
      const notificationConfig = {
        ...config,
        notificationsEnabled: true,
        notificationOrigin: "http://127.0.0.1:12345",
        notificationSecret: "n".repeat(32),
      };
      let published = 0;
      const fakeFetch = async () => {
        published++;
        return new Response("{}", { status: 200 });
      };
      assert.equal(
        await deliverNotifications(
          pool,
          notificationConfig,
          now,
          fakeFetch as typeof fetch,
        ),
        0,
      );
      assert.equal(published, 0, "maintenance delays pending delivery");
      await pool.query("UPDATE ops_maintenance SET expired_at=$1", [now]);
      await pool.query(
        "UPDATE ops_outbox SET next_attempt_at=$1,lease_until=NULL",
        [new Date()],
      );
      assert.ok(
        (await deliverNotifications(
          pool,
          notificationConfig,
          new Date(),
          fakeFetch as typeof fetch,
        )) > 0,
      );
      assert.ok(published > 0);
      const sent = published;
      await deliverNotifications(
        pool,
        notificationConfig,
        new Date(),
        fakeFetch as typeof fetch,
      );
      assert.equal(
        published,
        sent,
        "delivery does not duplicate completed intent",
      );
      const oldObservation = await pool.query(
        "INSERT INTO ops_observations(monitor_id,observed_at,received_at,snapshot) VALUES('growth',now()-interval '40 days',now()-interval '40 days',$1) RETURNING id",
        [sample(now)],
      );
      await retention(pool, new Date());
      assert.equal(
        (
          await pool.query("SELECT 1 FROM ops_observations WHERE id=$1", [
            oldObservation.rows[0].id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query("SELECT 1 FROM ops_observations WHERE id=$1", [
            active.observation_id,
          ])
        ).rowCount,
        1,
        "active evidence retained",
      );
      await pool.query(
        "UPDATE ops_monitors SET last_completed_at=now()-interval '10 minutes'",
      );
      await watchdog(pool, config, new Date());
      await watchdog(pool, config, new Date(Date.now() + 15000));
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) FROM ops_incidents WHERE source='operations' AND status<>'resolved'",
          )
        ).rows[0].count,
        "1",
        "independent watchdog opens stale monitor incident",
      );
      process.env.OPS_OIDC_ISSUER = "http://127.0.0.1:12345";
      process.env.OPS_OIDC_CLIENT_SECRET = "fixture-client-secret";
      process.env.OPS_SESSION_ENCRYPTION_KEY = "e".repeat(64);
      process.env.OPS_PUBLIC_URL = "http://localhost:3001";
      const session = randomBytes(32).toString("base64url"),
        hash = createHash("sha256").update(session).digest("hex");
      await pool.query(
        "INSERT INTO operations.admin_sessions(token_hash,admin_id,principal_revision,refresh_token,expires_at,refresh_after) VALUES($1,'operator',1,'not-needed-before-refresh',now()+interval '1 hour',now()+interval '1 hour')",
        [hash],
      );
      const app = await buildApi(pool, config);
      try {
        assert.equal(
          (await app.inject({ url: "/v1/incidents" })).statusCode,
          401,
        );
        const headers = {
          cookie: `labs_admin_session=${session}`,
          origin: "http://localhost:3001",
        };
        const listing = await app.inject({ url: "/v1/incidents", headers });
        assert.equal(listing.statusCode, 200);
        assert.ok(listing.json().items.length > 0);
        active = (
          await pool.query(
            "SELECT * FROM ops_incidents WHERE source='growth' AND status<>'resolved'",
          )
        ).rows[0];
        const action = {
          operationId: randomUUID(),
          expectedRevision: active.revision,
          action: "acknowledge",
          reason: "Investigating fixture incident",
        };
        const endpoint = `/v1/incidents/${active.id}/actions`;
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: endpoint,
              headers: { ...headers, origin: "http://evil.invalid" },
              payload: action,
            })
          ).statusCode,
          403,
        );
        const acknowledged = await app.inject({
          method: "POST",
          url: endpoint,
          headers,
          payload: action,
        });
        assert.equal(acknowledged.statusCode, 200, acknowledged.body);
        assert.equal(acknowledged.json().incident.status, "acknowledged");
        assert.deepEqual(
          (
            await app.inject({
              method: "POST",
              url: endpoint,
              headers,
              payload: action,
            })
          ).json(),
          acknowledged.json(),
          "same operation id returns saved receipt",
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: endpoint,
              headers,
              payload: {
                ...action,
                operationId: randomUUID(),
                expectedRevision: acknowledged.json().incident.revision,
                action: "resolve",
              },
            })
          ).statusCode,
          409,
          "breach cannot manually resolve",
        );
        const ruleResult = await app.inject({ url: "/v1/rules", headers });
        assert.equal(ruleResult.statusCode, 200);
        const targetRule = ruleResult
          .json()
          .items.find((r: any) => r.id === "growth:publication.quarantined");
        const policy = {
          ...targetRule,
          operationId: randomUUID(),
          expectedRevision: targetRule.revision,
          reason: "Fixture policy adjustment",
          threshold: "1",
        };
        const policySaved = await app.inject({
          method: "PUT",
          url: "/v1/rules/" + encodeURIComponent(targetRule.id),
          headers,
          payload: policy,
        });
        assert.equal(policySaved.statusCode, 200, policySaved.body);
        assert.equal(
          (
            await pool.query(
              "SELECT reason FROM ops_rule_versions WHERE rule_id=$1 ORDER BY revision DESC LIMIT 1",
              [targetRule.id],
            )
          ).rows[0].reason,
          "Fixture policy adjustment",
        );
        assert.equal(
          (
            await app.inject({
              method: "PUT",
              url: "/v1/rules/" + encodeURIComponent(targetRule.id),
              headers,
              payload: { ...policy, operationId: randomUUID() },
            })
          ).statusCode,
          409,
        );
        const maintenance = await app.inject({
          method: "POST",
          url: "/v1/maintenance",
          headers,
          payload: {
            operationId: randomUUID(),
            source: "growth",
            startsAt: new Date().toISOString(),
            endsAt: new Date(Date.now() + 60000).toISOString(),
            reason: "Fixture deployment maintenance",
          },
        });
        assert.equal(maintenance.statusCode, 200, maintenance.body);
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: "/v1/maintenance/" + maintenance.json().id + "/expire",
              headers,
              payload: {
                operationId: randomUUID(),
                reason: "Fixture deployment finished",
              },
            })
          ).statusCode,
          200,
        );
        const seen = new Set<string>();
        let auditCursor: string | null = null;
        for (let i = 0; i < 4; i++) {
          const query = new URLSearchParams({
            source: "operations",
            limit: "1",
            ...(auditCursor ? { cursor: auditCursor } : {}),
          });
          const response = await app.inject({
            url: "/v1/audit?" + query,
            headers,
          });
          assert.equal(response.statusCode, 200, response.body);
          const payload = response.json();
          assert.ok(payload.items.length <= 1);
          for (const entry of payload.items) {
            assert.equal(
              seen.has(entry.id),
              false,
              "audit pages do not repeat",
            );
            seen.add(entry.id);
          }
          auditCursor = payload.nextCursor;
          if (!auditCursor) break;
        }
        assert.ok(seen.size > 1);
        const viewerToken = randomBytes(32).toString("base64url");
        await pool.query(
          "INSERT INTO operations.admin_principals(admin_id,issuer,subject,role,name) VALUES('viewer','http://127.0.0.1:12345','viewer-subject','viewer','Viewer')",
        );
        await pool.query(
          "INSERT INTO operations.admin_sessions(token_hash,admin_id,principal_revision,refresh_token,expires_at,refresh_after) VALUES($1,'viewer',1,'unused',now()+interval '1 hour',now()+interval '1 hour')",
          [createHash("sha256").update(viewerToken).digest("hex")],
        );
        const viewerHeaders = {
          ...headers,
          cookie: "labs_admin_session=" + viewerToken,
        };
        assert.equal(
          (await app.inject({ url: "/v1/incidents", headers: viewerHeaders }))
            .statusCode,
          200,
        );
        assert.equal(
          (await app.inject({ url: "/v1/audit", headers: viewerHeaders }))
            .statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: "POST",
              url: endpoint,
              headers: viewerHeaders,
              payload: { ...action, operationId: randomUUID() },
            })
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await app.inject({
              method: "PUT",
              url: "/v1/rules/" + encodeURIComponent(targetRule.id),
              headers: viewerHeaders,
              payload: policy,
            })
          ).statusCode,
          403,
        );
        const parallel = await Promise.all(
          ["assign", "acknowledge"].map((actionName) =>
            app.inject({
              method: "POST",
              url: endpoint,
              headers,
              payload: {
                ...action,
                operationId: randomUUID(),
                expectedRevision: acknowledged.json().incident.revision,
                action: actionName,
                assignedTo: "operator",
              },
            }),
          ),
        );
        assert.deepEqual(
          parallel.map((r) => r.statusCode).sort(),
          [200, 409],
          "competing actors cannot overwrite same revision",
        );
        await pool.query(
          "UPDATE operations.admin_principals SET active=false WHERE admin_id='operator'",
        );
        assert.equal(
          (await app.inject({ url: "/v1/incidents", headers })).statusCode,
          401,
          "role revocation immediate",
        );
      } finally {
        await app.close();
      }
    } finally {
      await pool.end();
    }
  },
);

test(
  "fixed HTTP collector handles malformed, oversize, redirect, stale and transport failures",
  { skip: !database },
  async () => {
    const pool = createPool(database!);
    let mode = "healthy",
      requests = 0,
      redirects = 0;
    const server = createServer((req, res) => {
      requests++;
      if (req.url !== "/internal/operations/signals") {
        redirects++;
        res.end("{}");
        return;
      }
      assert.ok(req.headers["x-kasitek-operations-authority"]);
      assert.equal(req.headers["x-kasitek-admin-authority"], undefined);
      if (mode === "redirect") {
        res.writeHead(302, { location: "/forbidden" });
        res.end();
        return;
      }
      if (mode === "oversize") {
        res.end("x".repeat(70000));
        return;
      }
      if (mode === "malformed") {
        res.end("{bad");
        return;
      }
      const s = sample(new Date());
      if (mode === "wrong_environment") s.environment = "production";
      if (mode === "stale")
        s.observedAt = new Date(Date.now() - 190000).toISOString();
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ ...s, privatePayload: "MUST_NOT_BE_PERSISTED" }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`,
      config = loadConfig({
        ...baseEnv,
        OPS_SOURCES_JSON: JSON.stringify([
          {
            id: "growth",
            source: "growth",
            origin,
            secret: "o".repeat(32),
            intervalSeconds: 10,
          },
        ]),
      });
    try {
      await initialize(pool, config);
      for (const [kind, expected] of [
        ["healthy", null],
        ["malformed", "source_incompatible"],
        ["oversize", "source_incompatible"],
        ["redirect", "source_transport_failure"],
        ["wrong_environment", "source_incompatible"],
        ["stale", "source_clock_or_stale"],
      ] as const) {
        mode = kind;
        await pool.query(
          "UPDATE ops_monitors SET next_poll_at=now()-interval '1 second',lease_until=NULL,last_observed_at=NULL",
        );
        const claim = (await claimMonitors(pool, new Date()))[0]!;
        assert.ok(claim);
        assert.equal(await collect(pool, config, claim), true);
        const m = (
          await pool.query("SELECT * FROM ops_monitors WHERE id='growth'")
        ).rows[0];
        assert.equal(m.last_error, expected, kind);
        const latest = (
          await pool.query(
            "SELECT snapshot FROM ops_observations ORDER BY id DESC LIMIT 1",
          )
        ).rows[0].snapshot;
        assert.equal(
          JSON.stringify(latest).includes("MUST_NOT_BE_PERSISTED"),
          false,
        );
      }
      assert.equal(redirects, 0, "collector refuses redirects");
      assert.equal(requests, 6);
      await pool.query(
        "UPDATE ops_monitors SET next_poll_at=now()-interval '1 second',lease_until=NULL,last_observed_at=NULL",
      );
      const claim = (await claimMonitors(pool, new Date()))[0]!;
      const fail = async () => {
        throw new Error("network credentials should never be logged");
      };
      assert.equal(
        await collect(pool, config, claim, new Date(), fail as typeof fetch),
        true,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT last_error FROM ops_monitors WHERE id='growth'",
          )
        ).rows[0].last_error,
        "source_transport_failure",
      );
    } finally {
      await pool.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
