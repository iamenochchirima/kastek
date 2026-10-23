import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type pg from "pg";
import { createHash } from "node:crypto";
import type {
  OperationsActor,
  OperationsAuditEntry,
} from "@kasitek-labs/contracts";
import {
  createAdminAuthority,
  ADMIN_AUTHORITY_HEADER,
} from "@kasitek-labs/server-support/admin-authority";
import type { OperationsConfig } from "./config.js";
import { iso } from "./serializers.js";
const bad = (): never => {
  throw Object.assign(new Error("Check audit request fields"), {
    statusCode: 400,
  });
};
const safe = (v: unknown, max = 256): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f]/.test(v);
interface State {
  cursor?: string;
  done?: boolean;
}
interface Cursor {
  version: 1;
  digest: string;
  states: Record<string, State>;
}
function projection(
  v: Record<string, unknown>,
  source: string,
  environment: string,
): OperationsAuditEntry {
  for (const key of ["id", "action", "status", "resourceType", "resourceId"])
    if (!safe(v[key])) throw new Error("Invalid audit metadata");
  for (const key of ["actorId", "customerId", "operationId", "code"])
    if (v[key] != null && !safe(v[key]))
      throw new Error("Invalid audit metadata");
  if (
    v.source !== source ||
    v.environment !== environment ||
    typeof v.occurredAt !== "string" ||
    !Number.isFinite(Date.parse(v.occurredAt))
  )
    throw new Error("Invalid audit source");
  return {
    id: String(v.id),
    source: source as OperationsAuditEntry["source"],
    environment,
    occurredAt: new Date(v.occurredAt).toISOString(),
    actorId: v.actorId == null ? null : String(v.actorId),
    action: String(v.action),
    status: String(v.status),
    customerId: v.customerId == null ? null : String(v.customerId),
    resourceType: String(v.resourceType),
    resourceId: String(v.resourceId),
    operationId: v.operationId == null ? null : String(v.operationId),
    code: v.code == null ? null : String(v.code),
  };
}
export function registerAudit(
  app: FastifyInstance,
  pool: pg.Pool,
  config: OperationsConfig,
  actor: (
    r: FastifyRequest,
    p: FastifyReply,
    c?: "admin:read" | "admin:operate" | "admin:security" | "admin:write",
  ) => Promise<OperationsActor>,
) {
  app.get("/v1/audit", async (req, reply) => {
    const a = await actor(req, reply, "admin:security"),
      q = req.query as Record<string, string>,
      limit = Number(q.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) bad();
    const allowed = ["operations", "growth", "agents", "agency"];
    if (q.source && !allowed.includes(q.source)) bad();
    const filters = ["actorId", "customerId", "resourceId", "status", "action"];
    for (const key of filters) if (q[key] && !safe(q[key], 200)) bad();
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          source: q.source ?? null,
          environment: config.environment,
          ...Object.fromEntries(filters.map((k) => [k, q[k] ?? null])),
        }),
      )
      .digest("hex");
    let cursor: Cursor = { version: 1, digest, states: {} };
    if (q.cursor) {
      if (q.cursor.length > 8192) bad();
      try {
        const decoded = JSON.parse(
          Buffer.from(q.cursor, "base64url").toString(),
        );
        if (
          decoded.version !== 1 ||
          decoded.digest !== digest ||
          !decoded.states ||
          typeof decoded.states !== "object" ||
          Array.isArray(decoded.states)
        )
          bad();
        for (const [key, state] of Object.entries(decoded.states) as [
          string,
          State,
        ][]) {
          if (
            !allowed.includes(key) ||
            !state ||
            typeof state !== "object" ||
            (state.cursor !== undefined && !safe(state.cursor, 4000)) ||
            (state.done !== undefined && typeof state.done !== "boolean")
          )
            bad();
        }
        cursor = decoded;
      } catch {
        bad();
      }
    }
    const selected = allowed.filter((s) => !q.source || q.source === s);
    const pageLimit = Math.max(1, Math.floor(limit / selected.length)),
      items: OperationsAuditEntry[] = [],
      sources: {
        source: string;
        status: string;
      }[] = [];
    await Promise.all(
      selected.map(async (source) => {
        const state = cursor.states[source] ?? {};
        if (state.done) {
          sources.push({ source, status: "available" });
          return;
        }
        if (source === "operations") {
          const vals: any[] = [],
            clauses = ["true"];
          for (const [key, col] of [
            ["actorId", "actor_id"],
            ["customerId", "customer_id"],
            ["resourceId", "resource_id"],
            ["status", "status"],
            ["action", "action"],
          ])
            if (q[key!]) {
              vals.push(q[key!]);
              clauses.push(`${col}=$${vals.length}`);
            }
          if (state.cursor) {
            let pair: any;
            try {
              pair = JSON.parse(
                Buffer.from(state.cursor, "base64url").toString(),
              );
            } catch {
              bad();
            }
            if (!safe(pair?.id) || !Number.isFinite(Date.parse(pair?.at)))
              bad();
            vals.push(pair.at, pair.id);
            clauses.push(
              `(occurred_at,id)<($${vals.length - 1}::timestamptz,$${vals.length}::uuid)`,
            );
          }
          vals.push(pageLimit + 1);
          const rows = (
            await pool.query(
              `SELECT * FROM ops_audit WHERE ${clauses.join(" AND ")} ORDER BY occurred_at DESC,id DESC LIMIT $${vals.length}`,
              vals,
            )
          ).rows;
          for (const r of rows.slice(0, pageLimit))
            items.push(
              projection(
                {
                  id: r.id,
                  source,
                  environment: r.environment,
                  occurredAt: iso(r.occurred_at),
                  actorId: r.actor_id,
                  action: r.action,
                  status: r.status,
                  customerId: r.customer_id,
                  resourceType: r.resource_type,
                  resourceId: r.resource_id,
                  operationId: r.operation_id,
                  code: r.code,
                },
                source,
                config.environment,
              ),
            );
          cursor.states[source] =
            rows.length > pageLimit
              ? {
                  cursor: Buffer.from(
                    JSON.stringify({
                      at: iso(rows[pageLimit - 1]!.occurred_at),
                      id: rows[pageLimit - 1]!.id,
                    }),
                  ).toString("base64url"),
                }
              : { done: true };
          sources.push({ source, status: "available" });
          return;
        }
        const s = config.sources.find((s) => s.source === source);
        if (!s || !config.adminSecret) {
          sources.push({ source, status: "not_configured" });
          cursor.states[source] = { done: true };
          return;
        }
        try {
          const params = new URLSearchParams({ limit: String(pageLimit) });
          for (const key of filters) if (q[key]) params.set(key, q[key]!);
          if (state.cursor) params.set("cursor", state.cursor);
          const path = `/api/admin/operations/audit?${params}`,
            token = createAdminAuthority({
              secret: config.adminSecret,
              actor: a,
              audience: s.source,
              capability: "admin:security",
              method: "GET",
              path,
            });
          const response = await fetch(s.origin + path, {
            headers: { [ADMIN_AUTHORITY_HEADER]: token },
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
          if (!response.ok || !response.body)
            throw new Error("Unavailable audit source");
          const reader = response.body.getReader(),
            chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 65536) {
              await reader.cancel();
              throw new Error("Oversized audit");
            }
            chunks.push(part.value);
          }
          const payload = JSON.parse(Buffer.concat(chunks).toString());
          if (
            !Array.isArray(payload.entries) ||
            payload.entries.length > pageLimit ||
            (payload.nextCursor != null && !safe(payload.nextCursor, 4000))
          )
            throw new Error("Invalid audit page");
          const projected = payload.entries.map(
            (entry: Record<string, unknown>) =>
              projection(entry, source, config.environment),
          );
          items.push(...projected);
          cursor.states[source] = payload.nextCursor
            ? { cursor: payload.nextCursor }
            : { done: true };
          sources.push({ source, status: "available" });
        } catch {
          sources.push({ source, status: "unavailable" });
          cursor.states[source] = state;
        }
      }),
    );
    items.sort(
      (x, y) =>
        Date.parse(y.occurredAt) - Date.parse(x.occurredAt) ||
        x.source.localeCompare(y.source) ||
        x.id.localeCompare(y.id),
    );
    return {
      items,
      nextCursor: selected.some((s) => !cursor.states[s]?.done)
        ? Buffer.from(JSON.stringify(cursor)).toString("base64url")
        : null,
      sources,
      ordering:
        "independent source cursors; source clocks are not globally ordered",
    };
  });
}
