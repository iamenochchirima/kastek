import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { ApiError } from "../error.js";
import type { CoreContext } from "../context.js";
import {
  extractAdmin,
  resolveAdminContext,
  requireAdminRole,
  type AdminUser,
} from "../identity/admin-session.js";
import { SerdeFloat } from "@kasitek-labs/server-support/json";
import { queryI64, queryString, typedQuery } from "../typed-query.js";
import * as analytics from "../services/admin/analytics.js";
import * as reports from "../services/admin/reports.js";
import * as activity from "../services/admin/activity.js";
export async function authorizeAnalytics(
  request: FastifyRequest,
  core: CoreContext,
  admin: AdminUser,
): Promise<void> {
  const context = await resolveAdminContext(request, core);
  if (
    !context.effectiveGrants.has("admin:read") ||
    ![
      "viewer",
      "support",
      "operator",
      "security",
      "admin",
      "superadmin",
      "owner",
    ].includes(admin.role.trim().toLowerCase())
  )
    throw new ApiError(403, "forbidden", "Insufficient permissions");
}
export function signedInteger(value: unknown, query = false): bigint | null {
  if (value == null) return null;
  if (query) {
    if (typeof value !== "string" || !/^[-+]?\d+$/.test(value))
      throw new ApiError(400, "bad_request", "Invalid request");
  } else if (
    value instanceof SerdeFloat ||
    !(
      typeof value === "bigint" ||
      (typeof value === "number" && Number.isSafeInteger(value))
    )
  )
    throw new ApiError(400, "bad_request", "Invalid request");
  const integer = BigInt(value as string | number | bigint);
  if (integer < -(1n << 63n) || integer >= 1n << 63n)
    throw new ApiError(400, "bad_request", "Invalid request");
  return integer;
}
function text(value: unknown): string {
  if (typeof value !== "string")
    throw new ApiError(400, "bad_request", "Invalid request");
  return value;
}
function activityQuery(request: FastifyRequest): activity.ActivityQuery {
  const query = typedQuery<{
    days?: string;
    limit?: string;
    cursor?: string;
    domain?: string;
    action?: string;
    status?: string;
    severity?: string;
    organizationId?: string;
  }>(request.query, [
    "days",
    "limit",
    "cursor",
    "domain",
    "action",
    "status",
    "severity",
    "organizationId",
  ]);
  return {
    days: queryI64(query.days, "days") ?? null,
    limit: queryI64(query.limit, "limit") ?? null,
    cursor: query.cursor,
    domain: query.domain,
    action: query.action,
    status: query.status,
    severity: query.severity,
    organizationId: query.organizationId,
  };
}
export async function registerAdminAnalyticsRoutes(
  app: FastifyInstance,
  core: CoreContext,
): Promise<void> {
  const authorized = async (request: FastifyRequest, write = false) => {
    const admin = await extractAdmin(request, core);
    await authorizeAnalytics(request, core, admin);
    if (write) requireAdminRole(admin, ["admin", "superadmin", "owner"]);
    return admin;
  };
  for (const route of ["overview", "usage", "revenue", "customers"] as const)
    app.get(`/api/admin/analytics/${route}`, async (request) => {
      const query = typedQuery<{ days?: string }>(request.query, ["days"]),
        days = queryI64(query.days, "days") ?? null;
      await authorized(request);
      return analytics[route](core.pool, days);
    });
  app.get("/api/admin/activity", async (request) => {
    const query = activityQuery(request);
    await authorized(request);
    return activity.listActivity(core.pool, query);
  });
  app.get("/api/admin/activity/stream", async (request, reply) => {
    const query = activityQuery(request);
    await authorized(request);
    activity.validateActivityQuery(query);
    const controller = new AbortController();
    reply.raw.on("close", () => controller.abort());
    return reply
      .type("text/event-stream")
      .header("Cache-Control", "no-cache, no-transform")
      .header("Connection", "keep-alive")
      .send(
        Readable.from(
          activity.streamActivity(core.pool, query, controller.signal),
        ),
      );
  });
  app.get("/api/admin/reports", async (request) => {
    const admin = await authorized(request);
    return reports.listReports(core.pool, admin.id);
  });
  app.post("/api/admin/reports", async (request, reply) => {
    const admin = await authorized(request, true),
      body = request.body;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ApiError(400, "bad_request", "Invalid request");
    const input = body as Record<string, unknown>;
    return reply
      .code(201)
      .send(
        await reports.saveReport(core.pool, admin, {
          name: text(input.name),
          reportKey: text(input.reportKey),
          days: signedInteger(input.days),
          config: input.config,
        }),
      );
  });
  app.delete("/api/admin/reports/:reportId", async (request, reply) => {
    const admin = await authorized(request, true);
    await reports.removeReport(
      core.pool,
      admin.id,
      (request.params as Record<string, string>).reportId!,
    );
    return reply.code(204).send();
  });
  app.get("/api/admin/reports/export", async (request, reply) => {
    const query = typedQuery<{ report?: string; days?: string }>(
        request.query,
        ["report", "days"],
      ),
      days = queryI64(query.days, "days") ?? null,
      report = queryString(query.report, "report", true)!,
      admin = await authorized(request),
      result = await reports.exportReport(core.pool, admin.id, report, days);
    return reply
      .type("text/csv; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="${result.filename}"`,
      )
      .header("Cache-Control", "no-store")
      .send(result.bytes);
  });
}
