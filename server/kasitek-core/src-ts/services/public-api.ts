import { createId } from "@paralleldrive/cuid2";
import { randomBytes, randomUUID, createHash, createHmac } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CoreConfig } from "../config.js";
import type {
  RequestContext,
  PublicActionPolicy,
  InstallationCapabilities,
} from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { transaction } from "../db.js";
import {
  canonicalJson,
  parseCanonicalJson,
  wireInteger,
} from "@kasitek/server-support/json";
type Row = Record<string, unknown>;
const SQL = {
  audit_begin_request: [
    "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
    '\n        SELECT COUNT(*)::BIGINT\n        FROM "PublicApiRequest"\n        WHERE "orgId" = $1\n          AND "principalId" = $2\n          AND "createdAt" >= NOW() - INTERVAL \'1 minute\'\n        ',
    '\n        INSERT INTO "PublicApiRequest"\n            ("id", "orgId", "principalType", "principalId", "route", "method", "statusCode", "correlationId")\n        VALUES ($1, $2, $3, $4, $5, $6, 0, $7)\n        ',
    '\n        INSERT INTO "UsageEvent"\n            ("id", "orgId", "productKey", "metricKey", "quantity", "sourceType", "sourceId", "idempotencyKey", "metadata")\n        VALUES ($1, $2, \'workspace\', $3, 1, \'public_api\', $4, $5, $6)\n        ',
  ],
  audit_finish_request: [
    '\n        UPDATE "PublicApiRequest"\n        SET "statusCode" = $2, "action" = COALESCE($3, "action"), "updatedAt" = NOW()\n        WHERE "id" = $1\n        ',
  ],
  audit_metrics: [
    '\n        SELECT\n            COUNT(*)::BIGINT,\n            COUNT(*) FILTER (WHERE "statusCode" BETWEEN 200 AND 399)::BIGINT,\n            COUNT(*) FILTER (WHERE "statusCode" BETWEEN 400 AND 499)::BIGINT,\n            COUNT(*) FILTER (WHERE "statusCode" >= 500)::BIGINT,\n            COUNT(*) FILTER (WHERE "statusCode" = 0)::BIGINT\n        FROM "PublicApiRequest"\n        WHERE "orgId" = $1\n          AND "principalId" = $2\n          AND "createdAt" >= NOW() - INTERVAL \'1 hour\'\n        ',
  ],
  key_list: [
    '\n        SELECT id, "orgId", name, prefix, scopes,\n               CASE WHEN status = \'ACTIVE\' AND "expiresAt" IS NOT NULL AND "expiresAt" <= NOW()\n                    THEN \'EXPIRED\' ELSE status END AS status,\n               "createdById",\n               "lastUsedAt" AT TIME ZONE \'UTC\' AS "lastUsedAt",\n               "expiresAt" AT TIME ZONE \'UTC\' AS "expiresAt",\n               "revokedAt" AT TIME ZONE \'UTC\' AS "revokedAt",\n               "createdAt" AT TIME ZONE \'UTC\' AS "createdAt",\n               "updatedAt" AT TIME ZONE \'UTC\' AS "updatedAt"\n        FROM "DeveloperApiKey"\n        WHERE "orgId" = $1\n        ORDER BY "createdAt" DESC\n        ',
  ],
  key_create: [
    '\n        INSERT INTO "DeveloperApiKey"\n          (id, "orgId", name, prefix, "keyHash", scopes, status, "createdById", "expiresAt", "createdAt", "updatedAt")\n        VALUES ($1, $2, $3, $4, $5, $6, \'ACTIVE\', $7, $8, NOW(), NOW())\n        RETURNING id, "orgId", name, prefix, scopes, status, "createdById",\n                  "lastUsedAt" AT TIME ZONE \'UTC\' AS "lastUsedAt",\n                  "expiresAt" AT TIME ZONE \'UTC\' AS "expiresAt",\n                  "revokedAt" AT TIME ZONE \'UTC\' AS "revokedAt",\n                  "createdAt" AT TIME ZONE \'UTC\' AS "createdAt",\n                  "updatedAt" AT TIME ZONE \'UTC\' AS "updatedAt"\n        ',
  ],
  key_revoke: [
    '\n        UPDATE "DeveloperApiKey"\n        SET status = \'REVOKED\', "revokedAt" = NOW(), "updatedAt" = NOW()\n        WHERE id = $1 AND "orgId" = $2 AND status = \'ACTIVE\'\n        ',
  ],
  key_rotate: [
    'SELECT id FROM "DeveloperApiKey" WHERE id = $1 AND "orgId" = $2 AND status = \'ACTIVE\' FOR UPDATE',
    'SELECT name, "expiresAt" AT TIME ZONE \'UTC\' FROM "DeveloperApiKey" WHERE id = $1',
    'UPDATE "DeveloperApiKey" SET status = \'REVOKED\', "revokedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1',
    '\n        INSERT INTO "DeveloperApiKey"\n          (id, "orgId", name, prefix, "keyHash", scopes, status, "createdById", "expiresAt", "createdAt", "updatedAt")\n        VALUES ($1, $2, $3, $4, $5, $6, \'ACTIVE\', $7, $8, NOW(), NOW())\n        RETURNING id, "orgId", name, prefix, scopes, status, "createdById",\n                  "lastUsedAt" AT TIME ZONE \'UTC\' AS "lastUsedAt",\n                  "expiresAt" AT TIME ZONE \'UTC\' AS "expiresAt",\n                  "revokedAt" AT TIME ZONE \'UTC\' AS "revokedAt",\n                  "createdAt" AT TIME ZONE \'UTC\' AS "createdAt",\n                  "updatedAt" AT TIME ZONE \'UTC\' AS "updatedAt"\n        ',
  ],
  key_authenticate: [
    '\n        SELECT id, "orgId", "createdById", scopes\n        FROM "DeveloperApiKey"\n        WHERE "keyHash" = $1\n          AND status = \'ACTIVE\'\n          AND ("expiresAt" IS NULL OR "expiresAt" > NOW())\n        ',
    'UPDATE "DeveloperApiKey" SET "lastUsedAt" = NOW(), "updatedAt" = NOW() WHERE id = $1',
  ],
  transport_active_entitlements: [
    '\n        SELECT key\n        FROM "OrganizationEntitlementGrant"\n        WHERE "orgId" = $1\n          AND "startsAt" <= NOW()\n          AND ("endsAt" IS NULL OR "endsAt" > NOW())\n          AND jsonb_typeof(value) = \'boolean\'\n          AND (value #>> \'{}\')::boolean = TRUE\n        UNION\n        SELECT entitlement.key\n        FROM "OrganizationSubscription" subscription\n        JOIN "PlanEntitlement" entitlement ON entitlement."planId" = subscription."planId"\n        WHERE subscription."orgId" = $1\n          AND subscription.status IN (\n            \'TRIAL\'::"OrganizationSubscriptionStatus",\n            \'ACTIVE\'::"OrganizationSubscriptionStatus",\n            \'GRACE\'::"OrganizationSubscriptionStatus"\n          )\n          AND jsonb_typeof(entitlement.value) = \'boolean\'\n          AND (entitlement.value #>> \'{}\')::boolean = TRUE\n        ',
  ],
} as const;
export interface PublicActionDefinition extends PublicActionPolicy {
  version: string;
  owningDomain: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  approval: unknown;
  idempotency: unknown;
  requiredOAuthScopes: string[];
  requiredEntitlements: string[];
  dataClassification: unknown;
  audit: unknown;
  usage: unknown;
}
/** Every method delegates to a real organization-scoped domain implementation. */
export interface PublicDomainAdapter {
  definitions(): Iterable<PublicActionDefinition>;
  listContentPosts(context: RequestContext): Promise<unknown[]>;
  getContentPost(context: RequestContext, id: string): Promise<Row | null>;
  getContentActivity(context: RequestContext, id: string): Promise<Row | null>;
  createContentDraft(context: RequestContext, input: Row): Promise<Row>;
  updateContentDraft(
    context: RequestContext,
    id: string,
    input: Row,
  ): Promise<Row>;
  listContacts(context: RequestContext, filters: Row): Promise<Row>;
  listInboxConversations(context: RequestContext): Promise<Row>;
  listInboxMessages(context: RequestContext, id: string): Promise<Row>;
  listBookings(context: RequestContext): Promise<Row>;
  listCampaigns(context: RequestContext): Promise<Row>;
  getCampaignSummary(context: RequestContext, id: string): Promise<Row>;
  listTemplates(context: RequestContext, status: string | null): Promise<Row>;
}
export interface RequestAuditHandle {
  id: string;
  action: string | null;
  rateLimit: number;
  rateRemaining: number;
  rateResetSeconds: number;
  correlationId: string | null;
}
const missingKey = (): never => {
  throw new ApiError(404, "not_found", "Active API key not found");
};
const unsigned = (value: string | undefined, fallback: number): number =>
  value !== undefined &&
  /^\+?\d+$/.test(value) &&
  Number.isSafeInteger(Number(value)) && Number(value)<=4294967295
    ? Number(value)
    : fallback;
export const publicRateLimit = (config: CoreConfig): number =>
  Math.max(
    1,
    Math.min(
      10000,
      unsigned(config.env.KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE, 120),
    ),
  );
export async function beginRequest(
  pool: Pool,
  limit: number,
  context: RequestContext,
  method: string,
  route: string,
): Promise<RequestAuditHandle> {
  return transaction(pool, async (client) => {
    await client.query(SQL.audit_begin_request[0], [
      `${context.organizationId}:${context.principal.id}`,
    ]);
    const count = BigInt(
      (
        await client.query(SQL.audit_begin_request[1], [
          context.organizationId,
          context.principal.id,
        ])
      ).rows[0].count,
    );
    if (count >= BigInt(limit))
      throw new ApiError(
        429,
        "too_many_requests",
        "Public API rate limit exceeded; retry in a minute",
      );
    const id = createId();
    await client.query(SQL.audit_begin_request[2], [
      id,
      context.organizationId,
      context.principal.kind,
      context.principal.id,
      route,
      method,
      context.correlationId,
    ]);
    await client.query(SQL.audit_begin_request[3], [
      createId(),
      context.organizationId,
      "public_api_requests",
      id,
      `public-api:${id}`,
      canonicalJson({ principalType: context.principal.kind, route, method }),
    ]);
    return {
      id,
      action: null,
      rateLimit: limit,
      rateRemaining: Math.max(0, limit - Number(count) - 1),
      rateResetSeconds: 60,
      correlationId: context.correlationId,
    };
  });
}
export async function finishRequest(
  pool: Pool,
  handle: RequestAuditHandle,
  status: number,
): Promise<void> {
  await pool.query(SQL.audit_finish_request[0], [
    handle.id,
    status,
    handle.action,
  ]);
}
export async function requestMetrics(
  pool: Pool,
  context: RequestContext,
): Promise<Row> {
  const result = await pool.query({
      text: SQL.audit_metrics[0],
      values: [context.organizationId, context.principal.id],
      rowMode: "array",
    }),
    [total, successful, clientErrors, serverErrors, inFlight] = result
      .rows[0] as string[];
  return {
    schema: "kasitek-public-metrics-v1",
    windowSeconds: 3600,
    principal: { kind: context.principal.kind },
    requests: Object.fromEntries(
      Object.entries({
        total,
        successful,
        clientErrors,
        serverErrors,
        inFlight,
      }).map(([key, value]) => [key, wireInteger(value!)]),
    ),
  };
}
export async function activeEntitlements(
  pool: Pool,
  org: string,
): Promise<Set<string>> {
  return new Set(
    (await pool.query(SQL.transport_active_entitlements[0], [org])).rows.map(
      (row) => String(row.key),
    ),
  );
}
export const secretDigest = (secret: string): string =>
  createHash("sha256").update(secret).digest("hex");
function generateSecret() {
  const secret = `kst_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, 12), digest: secretDigest(secret) };
}
function keyMetadata(row: Row): Row {
  const { orgId: _, ...metadata } = row;
  return metadata;
}
export async function listApiKeys(pool: Pool, org: string): Promise<Row[]> {
  return (await pool.query(SQL.key_list[0], [org])).rows.map(keyMetadata);
}
export async function createApiKey(
  pool: Pool,
  org: string,
  actor: string,
  name: string,
  expiresAt: Date | null,
): Promise<{ key: Row; secret: string }> {
  name = name.trim();
  if (!name || Buffer.byteLength(name) > 80)
    throw new ApiError(
      400,
      "bad_request",
      "API key name must be between 1 and 80 characters",
    );
  if (expiresAt && expiresAt.getTime() <= Date.now())
    throw new ApiError(
      400,
      "bad_request",
      "API key expiry must be in the future",
    );
  const { secret, prefix, digest } = generateSecret(),
    row = (
      await pool.query(SQL.key_create[0], [
        createId(),
        org,
        name,
        prefix,
        digest,
        ["api:read", "api:write"],
        actor,
        expiresAt,
      ])
    ).rows[0];
  return { key: keyMetadata(row), secret };
}
export async function revokeApiKey(
  pool: Pool,
  org: string,
  id: string,
): Promise<void> {
  if ((await pool.query(SQL.key_revoke[0], [id, org])).rowCount === 0)
    missingKey();
}
export async function rotateApiKey(
  pool: Pool,
  org: string,
  actor: string,
  id: string,
): Promise<{ key: Row; secret: string }> {
  return transaction(pool, async (client) => {
    const previous = (await client.query(SQL.key_rotate[0], [id, org])).rows[0];
    if (!previous) missingKey();
    const old = (
        await client.query({
          text: SQL.key_rotate[1],
          values: [id],
          rowMode: "array",
        })
      ).rows[0] as [string, Date | null],
      { secret, prefix, digest } = generateSecret();
    await client.query(SQL.key_rotate[2], [id]);
    const created = (
      await client.query(SQL.key_rotate[3], [
        createId(),
        org,
        [...`${old[0]} (rotated)`].slice(0, 80).join(""),
        prefix,
        digest,
        ["api:read", "api:write"],
        actor,
        old[1],
      ])
    ).rows[0];
    return { key: keyMetadata(created), secret };
  });
}
export async function loadInstallationCapabilities(
  config: CoreConfig,
  context: RequestContext,
): Promise<InstallationCapabilities> {
  const env = config.env,
    base = env.AGENTS_API_URL?.trim().replace(/\/+$/, ""),
    secret = env.AGENTS_INTERNAL_AUTH_SECRET?.trim();
  if (!base)
    throw new ApiError(
      503,
      "service_unavailable",
      "Agent Platform is not configured",
    );
  if (!secret)
    throw new ApiError(
      503,
      "service_unavailable",
      "Agent Platform authentication is not configured",
    );
  if (!context.installationId)
    throw new ApiError(401, "unauthorized", "Unauthorized");
  const correlationId = randomUUID(),
    claims = {
      organizationId: context.organizationId,
      actorId: context.principal.id,
      correlationId,
      audience: env.AGENTS_INTERNAL_AUTH_AUDIENCE ?? "kasitek-agents",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      scopes: ["agents:read"],
    },
    payload = Buffer.from(JSON.stringify(claims)).toString("base64url"),
    token = `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`,
    credential = context.principal.clientId,
    path = `/v1/installations/${encodeURIComponent(context.installationId)}/capabilities${credential?.trim() ? `?credentialId=${encodeURIComponent(credential)}` : ""}`;
  let response: Response;
  try {
    response = await fetch(base + path, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-organization-id": context.organizationId,
        "x-actor-id": context.principal.id,
        "x-correlation-id": correlationId,
      },
      signal: AbortSignal.timeout(
        Math.min(
          120000,
          Math.max(500, unsigned(env.AGENTS_API_TIMEOUT_MS, 15000)),
        ),
      ),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    )
      throw new ApiError(
        504,
        "gateway_timeout",
        "Agent Platform request timed out",
      );
    const cause =
      error instanceof Error
        ? (error as Error & { cause?: { code?: string } }).cause?.code
        : undefined;
    if (
      cause &&
      ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(
        cause,
      )
    )
      throw new ApiError(
        503,
        "service_unavailable",
        "Agent Platform is unavailable",
      );
    throw new ApiError(502, "bad_gateway", "Agent Platform request failed");
  }
  if (!response.ok) {
    let detail: Row = {};
    try {
      const parsed = parseCanonicalJson(await response.text());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        detail = parsed as Row;
    } catch {}
    const message =
        typeof detail.error === "string"
          ? detail.error
          : "Agent Platform request failed",
      known = new Set([
        "google_oauth_integration_not_supported",
        "google_oauth_not_configured",
        "google_token_exchange_failed",
        "google_access_token_missing",
        "mcp_oauth_not_configured",
        "mcp_oauth_client_registration_unsupported",
        "mcp_oauth_client_registration_failed",
        "mcp_oauth_start_failed",
        "mcp_oauth_state_incomplete",
        "mcp_oauth_code_missing",
        "mcp_oauth_connection_failed",
      ]);
    if (typeof detail.code === "string" && known.has(detail.code))
      throw new ApiError(response.status, detail.code, message);
    if (detail.code === "conversation_handoff_active")
      throw new ApiError(409, "conversation_handoff_active", message);
    const [status, code] =
      response.status === 400 || response.status === 422
        ? [400, "bad_request"]
        : response.status === 401
          ? [401, "unauthorized"]
          : response.status === 403
            ? [403, "forbidden"]
            : response.status === 404
              ? [404, "not_found"]
              : response.status === 409
                ? [409, "conflict"]
                : response.status === 408 || response.status === 504
                  ? [504, "gateway_timeout"]
                  : response.status === 503
                    ? [503, "service_unavailable"]
                    : [502, "bad_gateway"];
    throw new ApiError(
      status as number,
      code as string,
      response.status === 401 ? "Unauthorized" : message,
    );
  }
  try {
    return parseCanonicalJson(
      await response.text(),
    ) as InstallationCapabilities;
  } catch {
    throw new ApiError(
      502,
      "bad_gateway",
      "Agent Platform returned an invalid response",
    );
  }
}
