import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ReportQueryInput } from "@kasitek-labs/contracts";
import { REPORTING_AUDIENCE } from "@kasitek-labs/contracts";
import {
  AnalyticsReportingClient,
  ReportingGrantIssuer,
  ReportingClientError,
  withScope,
  redactScopeId,
} from "@kasitek-labs/server-support/analytics-reporting";
import { createId } from "@paralleldrive/cuid2";
import type { TenantContext } from "../context.js";
import {
  bad as badRequest,
  forbidden,
  internal,
  RequestExtractionError,
} from "../error.js";
import { UtcTimestamp } from "../db.js";
import {
  extractTenantUserSession,
  extractTenantClientUserSession,
  requireTenantRoles,
  tenantUserHasAnyRole,
} from "../middleware.js";
import { WORKSPACE_READ_ROLES } from "./read-helpers.js";
const bad = () => new RequestExtractionError("json", "Invalid request");
export function parseReportQuery(value: unknown): ReportQueryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const data = value as Record<string, unknown>;
  const allowed = new Set([
    "range_start",
    "range_end",
    "timezone",
    "interval",
    "metrics",
    "metric_set",
    "breakdowns",
    "filters",
    "include_descendants",
    "comparison",
  ]);
  if (Object.keys(data).some((key) => !allowed.has(key))) throw bad();
  const time = (value: unknown): string => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(
        value,
      )
    )
      throw bad();
    try {
      return new UtcTimestamp(value, true).toJSON();
    } catch {
      throw bad();
    }
  };
  const strings = (value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
      throw bad();
    return value as string[];
  };
  if (typeof data.timezone !== "string") throw bad();
  const filters = data.filters ?? {};
  if (
    data.filters === null ||
    typeof filters !== "object" ||
    Array.isArray(filters)
  )
    throw bad();
  for (const values of Object.values(filters)) strings(values);
  for (const key of ["interval", "metric_set"])
    if (data[key] != null && typeof data[key] !== "string") throw bad();
  if (
    data.include_descendants !== undefined &&
    typeof data.include_descendants !== "boolean"
  )
    throw bad();
  let comparison: ReportQueryInput["comparison"];
  if (data.comparison != null) {
    if (
      typeof data.comparison !== "object" ||
      Array.isArray(data.comparison) ||
      Object.keys(data.comparison).some((key) => key !== "kind") ||
      typeof (data.comparison as Record<string, unknown>).kind !== "string"
    )
      throw bad();
    comparison = data.comparison as { kind: string };
  }
  return {
    range_start: time(data.range_start),
    range_end: time(data.range_end),
    timezone: data.timezone,
    metrics: strings(data.metrics),
    breakdowns: strings(data.breakdowns),
    filters: filters as Record<string, string[]>,
    include_descendants: data.include_descendants === true,
    ...(data.interval != null ? { interval: data.interval as string } : {}),
    ...(data.metric_set != null
      ? { metric_set: data.metric_set as string }
      : {}),
    ...(comparison ? { comparison } : {}),
  };
}
function dependencyFailure(request: FastifyRequest, error: unknown): never {
  if (error instanceof ReportingClientError) {
    request.log.warn(
      {
        event: "provider.call.failed",
        provider: "customer_analytics",
        operation: "report",
        status: error.status,
      },
      "tenant analytics upstream rejected gateway request",
    );
    if (error.status === 400)
      throw badRequest("Customer analytics rejected the report request");
    if (error.status === 401 || error.status === 403)
      throw internal("Customer analytics authorization failed");
    throw internal("Customer analytics is temporarily unavailable");
  }
  if (error instanceof SyntaxError) {
    request.log.error(
      {
        event: "provider.call.failed",
        provider: "customer_analytics",
        operation: "report",
        error_type: "invalid_response",
      },
      "tenant analytics returned invalid response",
    );
    throw internal("Customer analytics returned an invalid response");
  }
  request.log.warn(
    {
      event: "dependency.unavailable",
      dependency: "customer_analytics",
      operation: "request",
      error_type: error instanceof Error ? error.name : "unknown",
    },
    "tenant analytics request failed",
  );
  throw internal("Customer analytics is temporarily unavailable");
}
export async function issueReport(
  request: FastifyRequest,
  context: TenantContext,
  kind: string,
  external: string,
  principal: string,
  roles: string[],
  payload?: ReportQueryInput,
): Promise<unknown> {
  const config = context.config;
  const token = config.analytics_reporting_resolver_token,
    key = config.analytics_reporting_private_key;
  if (!token?.trim() || !key?.trim())
    throw internal("Customer analytics is not configured");
  let client: AnalyticsReportingClient, issuer: ReportingGrantIssuer;
  try {
    client = new AnalyticsReportingClient(
      config.analytics_reporting_url,
      token,
      config.analytics_reporting_timeout_ms,
    );
    issuer = await ReportingGrantIssuer.fromPem(
      key,
      config.analytics_reporting_issuer,
      config.analytics_reporting_audience.trim()
        ? config.analytics_reporting_audience
        : REPORTING_AUDIENCE,
      config.analytics_reporting_key_id ?? undefined,
    );
  } catch {
    request.log.error(
      {
        event: "dependency.unavailable",
        dependency: "customer_analytics",
        operation: "configuration",
        error_type: "configuration",
      },
      "tenant analytics gateway configuration failed",
    );
    throw internal("Customer analytics is not configured");
  }
  let scope;
  try {
    scope = await client.resolveScope("tenant-platform", kind, external);
    const i64 = (value: unknown) => {
      if (typeof value !== "number" && typeof value !== "bigint") return false;
      try {
        const exact = BigInt(value);
        return exact >= -(1n << 63n) && exact < 1n << 63n;
      } catch {
        return false;
      }
    };
    if (
      !scope ||
      typeof scope !== "object" ||
      Array.isArray(scope) ||
      !i64(scope.scope_id) ||
      !i64(scope.root_scope_id) ||
      ![
        scope.scope_kind,
        scope.owning_source_service,
        scope.external_source_id,
        scope.reporting_timezone,
      ].every((value) => typeof value === "string") ||
      (scope.parent_scope_id != null && !i64(scope.parent_scope_id))
    )
      throw new SyntaxError("Invalid reporting scope response");
  } catch (error) {
    dependencyFailure(request, error);
  }
  if (
    scope.owning_source_service !== "tenant-platform" ||
    scope.scope_kind !== kind ||
    scope.external_source_id !== external
  )
    throw internal("Customer analytics scope identity mismatch");
  const compare =
    kind === "tenant_workspace" &&
    tenantUserHasAnyRole(roles, ["owner", "admin", "account_manager"]);
  if (payload?.include_descendants && !compare) throw forbidden();
  let grant: string;
  try {
    grant = await issuer.issue({
      principal_id: principal,
      scope_id: scope.scope_id,
      root_scope_id: scope.root_scope_id,
      descendant_mode: compare ? "all" : "none",
      permissions: compare
        ? ["analytics:read", "analytics:compare_children"]
        : ["analytics:read"],
      metric_keys: [],
      dimension_keys: [],
      correlation_id: `tenant-${createId()}`,
    });
  } catch {
    request.log.error(
      {
        event: "operation.failed",
        operation: "customer_analytics.grant_signing",
        error_type: "signing",
      },
      "tenant analytics grant signing failed",
    );
    throw internal("Customer analytics authorization failed");
  }
  try {
    return redactScopeId(
      payload
        ? await client.report(grant, withScope(payload, scope.scope_id))
        : await client.catalog(grant, scope.scope_id),
      kind,
      external,
    );
  } catch (error) {
    dependencyFailure(request, error);
  }
}
export function registerAnalyticsRoutes(
  app: FastifyInstance,
  context: TenantContext,
): void {
  app.get("/api/analytics/catalog", async (request) => {
    const s = await extractTenantUserSession(request, context);
    requireTenantRoles(s.roles, WORKSPACE_READ_ROLES);
    return issueReport(
      request,
      context,
      "tenant_workspace",
      s.workspace_id,
      s.tenant_user_id,
      s.roles,
    );
  });
  app.post("/api/analytics/query", async (request) => {
    const payload = parseReportQuery(request.body),
      s = await extractTenantUserSession(request, context);
    requireTenantRoles(s.roles, WORKSPACE_READ_ROLES);
    return issueReport(
      request,
      context,
      "tenant_workspace",
      s.workspace_id,
      s.tenant_user_id,
      s.roles,
      payload,
    );
  });
  app.get("/api/client/analytics/catalog", async (request) => {
    const s = await extractTenantClientUserSession(request, context);
    requireTenantRoles(s.roles, ["owner", "admin", "member", "viewer"]);
    return issueReport(
      request,
      context,
      "tenant_client",
      s.tenant_client_id,
      s.tenant_client_user_id,
      s.roles,
    );
  });
  app.post("/api/client/analytics/query", async (request) => {
    const payload = parseReportQuery(request.body),
      s = await extractTenantClientUserSession(request, context);
    requireTenantRoles(s.roles, ["owner", "admin", "member", "viewer"]);
    return issueReport(
      request,
      context,
      "tenant_client",
      s.tenant_client_id,
      s.tenant_client_user_id,
      s.roles,
      payload,
    );
  });
}
