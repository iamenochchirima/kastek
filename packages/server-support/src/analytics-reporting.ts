import { createPrivateKey, randomUUID } from "node:crypto";
import { importPKCS8, CompactSign } from "jose";
import {
  REPORTING_AUDIENCE,
  REPORTING_POLICY_VERSION,
  MAX_GRANT_SECONDS,
  CATALOG_PATH,
  QUERY_PATH,
  SCOPE_RESOLVE_PATH,
} from "@kasitek/contracts";
import type {
  ReportingGrantInput,
  ScopeResolution,
  ReportQueryInput,
  ReportQueryRequest,
} from "@kasitek/contracts";
import {
  integer,
  wireInteger,
  timestamp,
  canonicalJson,
  parseLosslessJson,
} from "./json.js";
import { injectTraceContext, providerResultSpan } from "./telemetry.js";
export function redactScopeId(
  response: unknown,
  scopeKind: string,
  externalId: string,
): unknown {
  if (!response || typeof response !== "object" || Array.isArray(response))
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
export class AnalyticsReportingClient {
  private readonly baseUrl: string;
  constructor(
    baseUrl: string,
    private readonly resolverToken: string,
    private readonly timeoutMilliseconds = 10000,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (!this.baseUrl)
      throw new Error("analytics reporting URL cannot be empty");
    new URL(this.baseUrl);
  }
  private async request<T>(
    path: string,
    token: string,
    init: RequestInit = {},
  ): Promise<T> {
    return providerResultSpan(
      "kasitek-analytics",
      "reporting.request",
      async () => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        injectTraceContext(headers);
        const response = await fetch(this.baseUrl + path, {
          ...init,
          headers,
          signal: AbortSignal.timeout(this.timeoutMilliseconds),
        });
        const body = await response.text();
        if (!response.ok)
          throw new ReportingClientError(
            response.status,
            Array.from(body).slice(0, 500).join(""),
          );
        return parseLosslessJson(body) as T;
      },
    );
  }
  resolveScope(
    sourceService: string,
    scopeKind: string,
    externalSourceId: string,
  ): Promise<ScopeResolution> {
    return this.request(
      `${SCOPE_RESOLVE_PATH}?${new URLSearchParams({ scope_kind: scopeKind, external_source_id: externalSourceId })}`,
      this.resolverToken,
      { headers: { "x-source-service": sourceService } },
    );
  }
  catalog(grant: string, scopeId: number | bigint | string): Promise<unknown> {
    return this.request(
      `${CATALOG_PATH}?reporting_scope_id=${integer(scopeId)}`,
      grant,
    );
  }
  report(grant: string, request: ReportQueryRequest): Promise<unknown> {
    return this.request(QUERY_PATH, grant, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: canonicalJson(request),
    });
  }
}
