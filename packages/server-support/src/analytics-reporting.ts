import { createPrivateKey, randomUUID } from "node:crypto";
import { importPKCS8, CompactSign } from "jose";
import {
  REPORTING_AUDIENCE,
  REPORTING_POLICY_VERSION,
  MAX_GRANT_SECONDS,
  CATALOG_PATH,
  QUERY_PATH,
  SCOPE_RESOLVE_PATH,
} from "@kasitek-labs/contracts";
import type {
  ReportingGrantInput,
  ScopeResolution,
  ReportQueryInput,
  ReportQueryRequest,
} from "@kasitek-labs/contracts";
import {
  integer,
  wireInteger,
  timestamp,
  canonicalJson,
  parseSerdeValueJson,
  SerdeFloat,
} from "./json.js";
import { injectTraceContext, providerResultSpan } from "./telemetry.js";
export function redactScopeId(
  response: unknown,
  scopeKind: string,
  externalId: string,
): unknown {
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    response instanceof SerdeFloat
  )
    return response;
  const { scope_id: _, ...rest } = response as Record<string, unknown>;
  return { ...rest, scope: { kind: scopeKind, externalId } };
}
export class ReportingGrantIssuer {
  private constructor(
    private readonly key: CryptoKey,
    public readonly issuer: string,
    public readonly audience: string,
    public readonly keyId?: string,
  ) {}
  static async fromPem(
    pem: string,
    issuer: string,
    audience = REPORTING_AUDIENCE,
    keyId?: string,
  ): Promise<ReportingGrantIssuer> {
    if (!issuer.trim() || !audience.trim())
      throw new Error("reporting issuer and audience cannot be empty");
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error("reporting private key must be P-256");
    const pkcs8 = key.export({ type: "pkcs8", format: "pem" }).toString();
    return new ReportingGrantIssuer(
      await importPKCS8(pkcs8, "ES256"),
      issuer,
      audience,
      keyId?.trim() || undefined,
    );
  }
  async issue(input: ReportingGrantInput): Promise<string> {
    if (
      !input.principal_id.trim() ||
      integer(input.scope_id) <= 0n ||
      integer(input.root_scope_id) <= 0n
    )
      throw new Error("reporting scope IDs must be positive");
    if (input.descendant_mode === "explicit")
      throw new Error(
        "explicit descendant grants require a bounded scope list",
      );
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      principal_type: "user",
      scope_id: wireInteger(input.scope_id),
      root_scope_id: wireInteger(input.root_scope_id),
      descendant_mode: input.descendant_mode,
      explicit_descendant_scope_ids: [],
      permissions: [...new Set(input.permissions)].sort(),
      metric_keys: input.metric_keys,
      dimension_keys: input.dimension_keys,
      policy_version: REPORTING_POLICY_VERSION,
      correlation_id: input.correlation_id ?? null,
      iat: now,
      nbf: now,
      exp: now + MAX_GRANT_SECONDS,
      iss: this.issuer,
      aud: this.audience,
      sub: input.principal_id,
      jti: randomUUID(),
    };
    return new CompactSign(Buffer.from(canonicalJson(claims)))
      .setProtectedHeader({
        alg: "ES256",
        typ: "JWT",
        ...(this.keyId ? { kid: this.keyId } : {}),
      })
      .sign(this.key);
  }
}
export function withScope(
  input: ReportQueryInput,
  scopeId: number | bigint | string,
): ReportQueryRequest {
  const { interval, metric_set, comparison, ...required } = input;
  return {
    ...required,
    range_start: timestamp(input.range_start),
    range_end: timestamp(input.range_end),
    reporting_scope_id: wireInteger(scopeId),
    ...(interval != null ? { interval } : {}),
    ...(metric_set != null ? { metric_set } : {}),
    ...(comparison != null ? { comparison } : {}),
  };
}
export class ReportingClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`analytics reporting returned HTTP ${status}: ${body}`);
  }
}

/** Scope resolution is a typed Rust struct, unlike the catalog/report Value responses. */
function decodeScopeResolution(value: unknown): ScopeResolution {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value instanceof SerdeFloat
  )
    throw new SyntaxError("invalid analytics scope response");
  const input = value as Record<string, unknown>;
  const id = (key: string): number | bigint => {
    const current = input[key];
    if (
      (typeof current !== "number" || !Number.isSafeInteger(current)) &&
      typeof current !== "bigint"
    )
      throw new SyntaxError(`invalid analytics scope ${key}`);
    const parsed = BigInt(current);
    if (parsed < -(1n << 63n) || parsed > (1n << 63n) - 1n)
      throw new SyntaxError(`invalid analytics scope ${key}`);
    return current;
  };
  const text = (key: string): string => {
    if (typeof input[key] !== "string")
      throw new SyntaxError(`invalid analytics scope ${key}`);
    return input[key];
  };
  return {
    scope_id: id("scope_id"),
    scope_kind: text("scope_kind"),
    owning_source_service: text("owning_source_service"),
    external_source_id: text("external_source_id"),
    root_scope_id: id("root_scope_id"),
    parent_scope_id:
      input.parent_scope_id == null ? null : id("parent_scope_id"),
    reporting_timezone: text("reporting_timezone"),
  };
}
export class AnalyticsReportingClient {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly resolverToken: string,
    private readonly timeoutMilliseconds = 10000,
    private readonly signal?: AbortSignal,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (!this.baseUrl)
      throw new Error("analytics reporting URL cannot be empty");
    new URL(this.baseUrl);
  }
  withSignal(signal: AbortSignal): AnalyticsReportingClient {
    return new AnalyticsReportingClient(this.baseUrl, this.resolverToken, this.timeoutMilliseconds, signal);
  }
  private async request(
    operation: "reporting.resolve_scope" | "reporting.catalog" | "reporting.query",
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    return providerResultSpan(
      "kasitek-analytics",
      operation,
      async () => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        injectTraceContext(headers);
        const response = await fetch(this.baseUrl + path, {
          ...init,
          headers,
          signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMilliseconds)]) : AbortSignal.timeout(this.timeoutMilliseconds),
        });
        const body = await response.text();
        if (!response.ok)
          throw new ReportingClientError(
            response.status,
            Array.from(body).slice(0, 500).join(""),
          );
        return parseSerdeValueJson(body);
      },
    );
  }
  adminReport(parameters: URLSearchParams, authority: string): Promise<unknown> {
    return this.request("reporting.query", `/v1/admin/reporting?${parameters}`, this.resolverToken, {
      headers: { "x-kasitek-admin-authority": authority },
    });
  }
  async resolveScope(
    sourceService: string,
    scopeKind: string,
    externalSourceId: string,
  ): Promise<ScopeResolution> {
    return decodeScopeResolution(
      await this.request(
        "reporting.resolve_scope",
        `${SCOPE_RESOLVE_PATH}?${new URLSearchParams({ scope_kind: scopeKind, external_source_id: externalSourceId })}`,
        this.resolverToken,
        { headers: { "x-source-service": sourceService } },
      ),
    );
  }
  catalog(grant: string, scopeId: number | bigint | string): Promise<unknown> {
    return this.request(
      "reporting.catalog",
      `${CATALOG_PATH}?reporting_scope_id=${integer(scopeId)}`,
      grant,
    );
  }
  report(grant: string, request: ReportQueryRequest): Promise<unknown> {
    return this.request("reporting.query", QUERY_PATH, grant, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalJson(request),
    });
  }
}
