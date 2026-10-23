import Fastify, {
  type FastifyRequest,
  type FastifyReply,
  type FastifyInstance,
} from "fastify";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { OperationsActor } from "@kasitek-labs/contracts";
import { adminCapabilities } from "@kasitek-labs/server-support/admin-authority";
import { registerOperationsAuth } from "./auth.js";
import type { OperationsConfig } from "./config.js";
import { transaction } from "./db.js";
import { audit, emitTransition, watchdog } from "./engine.js";
import {
  incident,
  transition,
  rule,
  monitor,
  iso,
  type Row,
} from "./serializers.js";
import { registerAudit } from "./audit.js";
const uuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );
class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
const bad = (message = "Check request fields"): never => {
  throw new HttpError(400, message);
};
function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad();
  return v as Record<string, any>;
}
function reason(v: unknown): string {
  if (
    typeof v !== "string" ||
    v.trim().length < 3 ||
    v.length > 500 ||
    /[\x00-\x1f]/.test(v)
  )
    return bad("Reason required (3–500 characters)");
  return v.trim();
}
function revision(v: unknown): number {
  if (!Number.isInteger(v) || Number(v) < 1)
    return bad("Expected revision required");
  return Number(v);
}
function page(query: Record<string, any>): {
  limit: number;
  cursor: {
    at: string;
    id: string;
  } | null;
} {
  const limit = Number(query.limit ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    return bad("Invalid page size");
  let cursor = null;
  if (query.cursor) {
    try {
      const p = JSON.parse(
        Buffer.from(String(query.cursor), "base64url").toString(),
      );
      if (!Number.isFinite(Date.parse(p.at)) || !uuid(p.id))
        return bad("Invalid cursor");
      cursor = p;
    } catch {
      return bad("Invalid cursor");
    }
  }
  return { limit, cursor };
}
const encodeCursor = (r: Row, field: string) =>
  Buffer.from(JSON.stringify({ at: iso(r[field]), id: r.id })).toString(
    "base64url",
  );
function permission(
  actor: OperationsActor,
  cap: "admin:read" | "admin:operate" | "admin:security" | "admin:write",
): void {
  if (
    !adminCapabilities(actor.role).has(cap) ||
    (cap === "admin:write" &&
      !["admin", "owner", "superadmin"].includes(actor.role))
  )
    throw new HttpError(403, "Permission denied");
}
export async function buildApi(pool: pg.Pool, config: OperationsConfig) {
  const app = Fastify({
    logger: {
      serializers: {
        req(request) {
          return { method: request.method, url: request.url?.split("?")[0] };
        },
      },
      redact: [
        "req.headers.cookie",
        "req.headers.authorization",
        "req.headers.x-kasitek-admin-authority",
        "req.headers.x-kasitek-operations-authority",
      ],
    },
    bodyLimit: 65536,
    trustProxy: false,
  });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error & {
      statusCode?: number;
    };
    const status = e.statusCode ?? 500;
    reply
      .code(status)
      .send({ error: status >= 500 ? "Operations unavailable" : e.message });
  });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    },
  );
  const auth = await registerOperationsAuth(app, pool, {
    ...process.env,
    ENVIRONMENT: config.environment,
  });
  async function actor(
    req: FastifyRequest,
    reply: FastifyReply,
    cap:
      | "admin:read"
      | "admin:operate"
      | "admin:security"
      | "admin:write" = "admin:read",
  ): Promise<OperationsActor> {
    const a = await auth.authenticate(req);
    if (!a) throw new HttpError(401, "Authentication required");
    if (!["GET", "HEAD"].includes(req.method)) {
      const origin = req.headers.origin;
      if (typeof origin !== "string" || !config.allowedOrigins.includes(origin))
        throw new HttpError(403, "Origin denied");
    }
    try {
      permission(a, cap);
    } catch (e) {
      await transaction(pool, (c) =>
        audit(
          c,
          config.environment,
          a.id,
          "access.denied",
          "denied",
          "route",
          req.routeOptions.url ?? "/unknown",
          null,
          "permission_denied",
        ),
      );
      throw e;
    }
    reply.header("cache-control", "private, no-store");
    return a;
  }
  async function command(
    req: FastifyRequest,
    a: OperationsActor,
    run: (c: pg.PoolClient, b: Record<string, any>) => Promise<unknown>,
  ): Promise<unknown> {
    const b = object(req.body);
    if (!uuid(b.operationId)) return bad("Operation ID required");
    const digest = createHash("sha256")
      .update(JSON.stringify({ path: req.url, body: b }))
      .digest("hex");
    return transaction(pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        b.operationId,
      ]);
      const old = (
        await c.query("SELECT * FROM ops_commands WHERE operation_id=$1", [
          b.operationId,
        ])
      ).rows[0];
      if (old) {
        if (old.actor_id !== a.id || old.body_digest !== digest)
          throw new HttpError(409, "Operation ID already used");
        return old.response;
      }
      const response = await run(c, b);
      await c.query(
        "INSERT INTO ops_commands(operation_id,actor_id,body_digest,response) VALUES($1,$2,$3,$4)",
        [b.operationId, a.id, digest, JSON.stringify(response)],
      );
      return response;
    }).catch(async (error: unknown) => {
      const status = error instanceof HttpError ? error.statusCode : 500;
      await transaction(pool, (c) =>
        audit(
          c,
          config.environment,
          a.id,
          "command.rejected",
          status === 403 ? "denied" : status < 500 ? "rejected" : "unknown",
          "route",
          req.routeOptions.url ?? "/unknown",
          b.operationId,
          status === 409
            ? "state_conflict"
            : status < 500
              ? "invalid_request"
              : "command_failed",
        ),
      ).catch(() => {});
      throw error;
    });
  }
  app.get("/health/live", async () => ({ status: "alive" }));
  app.get("/health/ready", async (_req, reply) => {
    try {
      await pool.query("SELECT 1 FROM ops_monitors LIMIT 1");
      await pool.query("SELECT reason FROM ops_rule_versions LIMIT 1");
      await pool.query("SELECT disposition FROM ops_outbox LIMIT 1");
      await pool.query("SELECT 1 FROM operations.admin_sessions LIMIT 1");
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/v1/status", async (req, reply) => {
    await actor(req, reply);
    const now = new Date();
    const progress = (
      await pool.query("SELECT max(updated_at) at FROM ops_worker_progress")
    ).rows[0];
    const age = progress?.at
      ? Math.max(
          0,
          Math.floor((now.getTime() - new Date(progress.at).getTime()) / 1000),
        )
      : null;
    const backlog = (
      await pool.query(
        "SELECT count(*)::text count,min(created_at) oldest FROM ops_outbox WHERE delivered_at IS NULL",
      )
    ).rows[0];
    return {
      environment: config.environment,
      collectionEnabled: config.collectionEnabled,
      evaluationEnabled: config.evaluationEnabled,
      notificationsEnabled: config.notificationsEnabled,
      worker: {
        status: !config.collectionEnabled
          ? "disabled"
          : age === null
            ? "not_started"
            : age > 30
              ? "stale"
              : "healthy",
        lastProgressAt: iso(progress?.at),
        ageSeconds: age,
      },
      notificationBacklog: backlog.count,
      oldestPendingNotificationAt: iso(backlog.oldest),
      selfHealthLimit:
        "Total Operations outage requires an independently hosted uptime monitor",
    };
  });
  app.get("/v1/incidents", async (req, reply) => {
    await actor(req, reply);
    const q = object(req.query),
      p = page(q),
      values: any[] = [];
    let clauses = ["true"];
    for (const [key, col, allowed] of [
      [
        "source",
        "source",
        ["growth", "agents", "agency", "analytics", "operations"],
      ],
      ["status", "status", ["open", "acknowledged", "resolved", "active"]],
      ["severity", "severity", ["warning", "critical"]],
    ] as const) {
      if (q[key]) {
        if (!allowed.includes(q[key] as never)) bad("Invalid filter");
        if (key === "status" && q[key] === "active")
          clauses.push("status<>'resolved'");
        else {
          values.push(q[key]);
          clauses.push(`${col}=$${values.length}`);
        }
      }
    }
    if (q.environment && q.environment !== config.environment)
      return { items: [], nextCursor: null };
    if (q.assignedTo) {
      if (typeof q.assignedTo !== "string" || q.assignedTo.length > 160) bad();
      values.push(q.assignedTo);
      clauses.push(`assigned_to=$${values.length}`);
    }
    if (p.cursor) {
      values.push(p.cursor.at, p.cursor.id);
      clauses.push(
        `(opened_at,id)<($${values.length - 1}::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(p.limit + 1);
    const rows = (
      await pool.query(
        `SELECT * FROM ops_incidents WHERE ${clauses.join(" AND ")} ORDER BY opened_at DESC,id DESC LIMIT $${values.length}`,
        values,
      )
    ).rows;
    const extra = rows.length > p.limit,
      items = rows.slice(0, p.limit);
    return {
      items: items.map(incident),
      nextCursor: extra ? encodeCursor(items.at(-1)!, "opened_at") : null,
    };
  });
  app.get<{
    Params: {
      id: string;
    };
  }>("/v1/incidents/:id", async (req, reply) => {
    await actor(req, reply);
    if (!uuid(req.params.id)) bad();
    const row = (
      await pool.query("SELECT * FROM ops_incidents WHERE id=$1", [
        req.params.id,
      ])
    ).rows[0];
    if (!row) throw new HttpError(404, "Incident not found");
    const transitions = (
      await pool.query(
        "SELECT * FROM ops_transitions WHERE incident_id=$1 ORDER BY revision DESC LIMIT 100",
        [row.id],
      )
    ).rows.map(transition);
    const observations = (
      await pool.query(
        "SELECT observed_at,error_code,snapshot FROM ops_observations WHERE monitor_id IN(SELECT id FROM ops_monitors WHERE source=$1) ORDER BY observed_at DESC LIMIT 20",
        [row.source],
      )
    ).rows.map((r) => ({
      observedAt: iso(r.observed_at),
      code: r.error_code,
      signals: r.snapshot.signals.filter(
        (s: any) => s.key === row.signal_key && s.group === row.group_key,
      ),
    }));
    return { incident: incident(row), transitions, observations };
  });
  app.post<{
    Params: {
      id: string;
    };
  }>("/v1/incidents/:id/actions", async (req, reply) => {
    const a = await actor(req, reply, "admin:operate");
    if (!uuid(req.params.id)) bad();
    return command(req, a, async (c, b) => {
      const why = reason(b.reason),
        expected = revision(b.expectedRevision);
      if (!["acknowledge", "assign", "resolve"].includes(b.action)) bad();
      const row = (
        await c.query("SELECT * FROM ops_incidents WHERE id=$1 FOR UPDATE", [
          req.params.id,
        ])
      ).rows[0];
      if (!row) throw new HttpError(404, "Incident not found");
      if (row.revision !== expected || row.status === "resolved")
        throw new HttpError(409, "Incident changed; refresh before acting");
      if (
        b.action === "resolve" &&
        (row.condition !== "healthy" ||
          !row.observed_at ||
          new Date(row.observed_at).getTime() < Date.now() - 180000)
      )
        throw new HttpError(409, "Fresh healthy evidence required");
      if (b.action === "assign" && b.assignedTo !== null) {
        if (
          typeof b.assignedTo !== "string" ||
          !(
            await c.query(
              "SELECT 1 FROM operations.admin_principals WHERE admin_id=$1 AND active=true AND role IN ('operator','admin','owner','superadmin')",
              [b.assignedTo],
            )
          ).rowCount
        )
          bad("Choose an active operator");
      }
      const now = new Date(),
        updated = (
          await c.query(
            `UPDATE ops_incidents SET revision=revision+1,updated_at=$2,status=CASE WHEN $3='acknowledge' THEN 'acknowledged' WHEN $3='resolve' THEN 'resolved' ELSE status END,assigned_to=CASE WHEN $3='assign' THEN $4 ELSE assigned_to END,resolved_at=CASE WHEN $3='resolve' THEN $2 ELSE resolved_at END WHERE id=$1 RETURNING *`,
            [row.id, now, b.action, b.assignedTo ?? null],
          )
        ).rows[0];
      await emitTransition(
        c,
        config,
        updated,
        b.action === "acknowledge"
          ? "acknowledged"
          : b.action === "assign"
            ? "assigned"
            : "resolved",
        a.id,
        why,
        now,
      );
      return { incident: incident(updated) };
    });
  });
  app.get("/v1/monitors", async (req, reply) => {
    await actor(req, reply);
    return {
      items: (
        await pool.query(
          "SELECT * FROM ops_monitors ORDER BY source,id LIMIT 100",
        )
      ).rows.map(monitor),
      nextCursor: null,
    };
  });
  app.get("/v1/operators", async (req, reply) => {
    await actor(req, reply);
    return {
      items: (
        await pool.query(
          "SELECT admin_id id,role,name,email FROM operations.admin_principals WHERE active=true AND role IN ('operator','admin','owner','superadmin') ORDER BY name,admin_id LIMIT 100",
        )
      ).rows,
      nextCursor: null,
    };
  });
  app.get("/v1/rules", async (req, reply) => {
    await actor(req, reply);
    return {
      items: (
        await pool.query(
          "SELECT * FROM ops_rules ORDER BY source,signal_key LIMIT 100",
        )
      ).rows.map(rule),
      nextCursor: null,
    };
  });
  app.put<{
    Params: {
      id: string;
    };
  }>("/v1/rules/:id", async (req, reply) => {
    const a = await actor(req, reply, "admin:write");
    if (req.params.id.length > 200) bad();
    return command(req, a, async (c, b) => {
      const why = reason(b.reason),
        expected = revision(b.expectedRevision);
      if (
        typeof b.enabled !== "boolean" ||
        typeof b.threshold !== "string" ||
        !/^\d{1,18}$/.test(b.threshold) ||
        !Number.isInteger(b.minimumSamples) ||
        b.minimumSamples < 0 ||
        b.minimumSamples > 1000000 ||
        !Number.isInteger(b.breachCount) ||
        b.breachCount < 1 ||
        b.breachCount > 20 ||
        !Number.isInteger(b.recoveryCount) ||
        b.recoveryCount < 2 ||
        b.recoveryCount > 20 ||
        !["warning", "critical"].includes(b.severity)
      )
        bad();
      const row = (
        await c.query(
          "UPDATE ops_rules SET enabled=$3,threshold=$4,minimum_samples=$5,breach_count=$6,recovery_count=$7,severity=$8,revision=revision+1 WHERE id=$1 AND revision=$2 RETURNING *",
          [
            req.params.id,
            expected,
            b.enabled,
            b.threshold,
            b.minimumSamples,
            b.breachCount,
            b.recoveryCount,
            b.severity,
          ],
        )
      ).rows[0];
      if (!row) throw new HttpError(409, "Rule changed; refresh before acting");
      const result = rule(row);
      await c.query(
        "INSERT INTO ops_rule_versions(rule_id,revision,value,actor_id,reason) VALUES($1,$2,$3,$4,$5)",
        [row.id, row.revision, result, a.id, why],
      );
      await audit(
        c,
        config.environment,
        a.id,
        "rule.updated",
        "succeeded",
        "rule",
        row.id,
        b.operationId,
      );
      return { rule: result, reason: why };
    });
  });
  app.get("/v1/maintenance", async (req, reply) => {
    await actor(req, reply);
    const q = object(req.query),
      p = page(q),
      values: any[] = [];
    let clause = "true";
    if (p.cursor) {
      values.push(p.cursor.at, p.cursor.id);
      clause = "(starts_at,id)<($1::timestamptz,$2::uuid)";
    }
    values.push(p.limit + 1);
    const rows = (
        await pool.query(
          `SELECT * FROM ops_maintenance WHERE ${clause} ORDER BY starts_at DESC,id DESC LIMIT $${values.length}`,
          values,
        )
      ).rows,
      items = rows.slice(0, p.limit).map((r) => ({
        id: r.id,
        source: r.source,
        ruleId: r.rule_id,
        startsAt: iso(r.starts_at),
        endsAt: iso(r.ends_at),
        expiredAt: iso(r.expired_at),
        reason: r.reason,
        actorId: r.actor_id,
      }));
    return {
      items,
      nextCursor:
        rows.length > p.limit
          ? encodeCursor(rows[p.limit - 1]!, "starts_at")
          : null,
    };
  });
  app.post("/v1/maintenance", async (req, reply) => {
    const a = await actor(req, reply, "admin:write");
    return command(req, a, async (c, b) => {
      const why = reason(b.reason),
        start = new Date(b.startsAt),
        end = new Date(b.endsAt);
      if (
        !Number.isFinite(+start) ||
        !Number.isFinite(+end) ||
        end <= start ||
        end.getTime() - start.getTime() > 7 * 86400000 ||
        end.getTime() <= Date.now()
      )
        bad("Maintenance must end within seven days");
      if (
        b.source != null &&
        !["growth", "agents", "agency", "analytics", "operations"].includes(
          b.source,
        )
      )
        bad();
      if (b.ruleId != null) {
        const r = (
          await c.query("SELECT source FROM ops_rules WHERE id=$1", [b.ruleId])
        ).rows[0];
        if (!r || (b.source && r.source !== b.source))
          bad("Invalid rule scope");
      }
      const id = randomUUID();
      await c.query(
        "INSERT INTO ops_maintenance(id,source,rule_id,starts_at,ends_at,reason,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id, b.source ?? null, b.ruleId ?? null, start, end, why, a.id],
      );
      await audit(
        c,
        config.environment,
        a.id,
        "maintenance.created",
        "succeeded",
        "maintenance",
        id,
        b.operationId,
      );
      return { id };
    });
  });
  app.post<{
    Params: {
      id: string;
    };
  }>("/v1/maintenance/:id/expire", async (req, reply) => {
    const a = await actor(req, reply, "admin:write");
    if (!uuid(req.params.id)) bad();
    return command(req, a, async (c, b) => {
      reason(b.reason);
      const result = await c.query(
        "UPDATE ops_maintenance SET expired_at=now() WHERE id=$1 AND expired_at IS NULL RETURNING id",
        [req.params.id],
      );
      if (!result.rowCount) throw new HttpError(409, "Maintenance changed");
      await audit(
        c,
        config.environment,
        a.id,
        "maintenance.expired",
        "succeeded",
        "maintenance",
        req.params.id,
        b.operationId,
      );
      return { id: req.params.id };
    });
  });
  registerAudit(app, pool, config, actor);
  let watching = false;
  const watchdogTimer = setInterval(() => {
    if (watching) return;
    watching = true;
    void watchdog(pool, config, new Date())
      .catch(() => {
        app.log.error({
          event: "watchdog_failed",
          code: "database_unavailable",
        });
      })
      .finally(() => {
        watching = false;
      });
  }, 15000);
  watchdogTimer.unref();
  app.addHook("onClose", async () => clearInterval(watchdogTimer));
  return app;
}
