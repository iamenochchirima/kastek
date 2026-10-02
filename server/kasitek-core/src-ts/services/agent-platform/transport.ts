import { randomUUID } from "node:crypto";
import type { CoreConfig } from "../../config.js";
import { ApiError } from "../../error.js";
import { signInternalAuth } from "../../identity/internal-delegation.js";
import { canonicalJson, parseLosslessJson } from "@kasitek/server-support/json";
export interface AgentTransportOptions {
  fetch?: typeof fetch;
  correlationId?: () => string;
  now?: () => number;
  traceHeaders?: () => Record<string, string>;
  log?: { error(fields: Record<string, unknown>, message?: string): void };
}
const knownCodes = new Set([
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
function envU32(value: string | undefined, fallback: number): number {
  if (value === undefined || !/^\+?\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed <= 4294967295 ? parsed : fallback;
}
export class AgentPlatformTransport {
  readonly baseUrl: string;
  readonly audience: string;
  readonly timeoutMs: number;
  private readonly secret: string;
  constructor(
    config: CoreConfig,
    protected readonly options: AgentTransportOptions = {},
  ) {
    const base = config.env.AGENTS_API_URL,
      secret = config.env.AGENTS_INTERNAL_AUTH_SECRET;
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
    this.baseUrl = base.replace(/\/+$/, "");
    this.secret = secret;
    this.audience =
      config.rawEnv.AGENTS_INTERNAL_AUTH_AUDIENCE ?? "kasitek-agents";
    this.timeoutMs = Math.max(
      500,
      Math.min(120000, envU32(config.rawEnv.AGENTS_API_TIMEOUT_MS, 15000)),
    );
  }
  protected async send(
    method: string,
    path: string,
    organizationId: string,
    actorId: string,
    scopes: string[],
    body?: RequestInit["body"],
    extraHeaders: Record<string, string> = {},
    operator = false,
    stream = false,
  ): Promise<Response> {
    const correlationId = (this.options.correlationId ?? randomUUID)(),
      now = Math.floor((this.options.now ?? Date.now)() / 1000);
    if (now < 0)
      throw new ApiError(
        500,
        "internal_error",
        "System clock is before Unix epoch",
      );
    const token = signInternalAuth(this.secret, {
      organizationId,
      actorId,
      correlationId,
      audience: this.audience,
      expiresAt: now + 60,
      scopes,
      ...(operator ? { operator: true } : {}),
    });
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );
    timer.unref();
    try {
      const response = await (this.options.fetch ?? fetch)(
        `${this.baseUrl}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "x-organization-id": organizationId,
            "x-actor-id": actorId,
            "x-correlation-id": correlationId,
            ...(operator ? { "x-kasitek-operator": "true" } : {}),
            ...extraHeaders,
            ...this.options.traceHeaders?.(),
          },
          ...(body == null ? {} : { body }),
          signal: controller.signal,
        },
      );
      if (stream) {
        clearTimeout(timer);
        timer = undefined;
        return response;
      }
      const bytes = await response.arrayBuffer();
      return new Response(
        response.status === 204 || response.status === 205 ? null : bytes,
        {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        },
      );
    } catch (error) {
      if (
        controller.signal.aborted ||
        (error instanceof Error && /timeout|timed out/i.test(error.message))
      )
        throw new ApiError(
          504,
          "gateway_timeout",
          "Agent Platform request timed out",
        );
      const cause = (error as { cause?: { code?: string } })?.cause;
      if (
        cause?.code &&
        [
          "ECONNREFUSED",
          "ENOTFOUND",
          "EHOSTUNREACH",
          "ENETUNREACH",
          "UND_ERR_CONNECT_TIMEOUT",
        ].includes(cause.code)
      )
        throw new ApiError(
          503,
          "service_unavailable",
          "Agent Platform is unavailable",
        );
      this.options.log?.error(
        {
          event: "provider.call.failed",
          provider: "kasitek-agents",
          operation: "http.request",
          error_type: error instanceof Error ? error.name : "unknown",
        },
        "Agent Platform request failed",
      );
      throw new ApiError(502, "bad_gateway", "Agent Platform request failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  protected async parseResponse(
    response: Response,
    allowNoContent = true,
  ): Promise<unknown> {
    if (!response.ok) throw await this.mapStatus(response);
    if (allowNoContent && response.status === 204) return null;
    try {
      return parseLosslessJson(await response.text());
    } catch {
      this.options.log?.error(
        {
          event: "provider.call.failed",
          provider: "kasitek-agents",
          operation: "http.request",
        },
        "Agent Platform returned invalid JSON",
      );
      throw new ApiError(
        502,
        "bad_gateway",
        "Agent Platform returned an invalid response",
      );
    }
  }
  async requestJson(
    method: string,
    path: string,
    org: string,
    actor: string,
    scopes: string[],
    body: unknown = undefined,
  ): Promise<unknown> {
    return this.parseResponse(
      await this.send(
        method,
        path,
        org,
        actor,
        scopes,
        body === undefined ? null : canonicalJson(body),
        body === undefined ? {} : { "Content-Type": "application/json" },
      ),
    );
  }
  async requestBytes(
    method: string,
    path: string,
    org: string,
    actor: string,
    scopes: string[],
    contentType: string,
    body: Buffer,
  ): Promise<unknown> {
    return this.parseResponse(
      await this.send(method, path, org, actor, scopes, new Uint8Array(body), {
        "Content-Type": contentType,
      }),
    );
  }
  async requestMultipart(
    method: string,
    path: string,
    org: string,
    actor: string,
    scopes: string[],
    body: FormData,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    return this.parseResponse(
      await this.send(method, path, org, actor, scopes, body, headers),
      false,
    );
  }
  async requestOperatorJson(
    method: string,
    path: string,
    actor: string,
    scopes: string[],
    body: unknown = undefined,
  ): Promise<unknown> {
    return this.parseResponse(
      await this.send(
        method,
        path,
        "platform",
        actor,
        scopes,
        body === undefined ? null : canonicalJson(body),
        body === undefined ? {} : { "Content-Type": "application/json" },
        true,
      ),
    );
  }
  async requestOperatorCommand(
    method: string,
    path: string,
    actor: string,
    scopes: string[],
    key: string | null,
    body: unknown = undefined,
  ): Promise<unknown> {
    return this.parseResponse(
      await this.send(
        method,
        path,
        "platform",
        actor,
        scopes,
        body === undefined ? null : canonicalJson(body),
        {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(key === null ? {} : { "idempotency-key": key }),
        },
        true,
      ),
      false,
    );
  }
  async requestOAuthCallback(path: string): Promise<unknown> {
    const response = await this.send(
      "GET",
      path,
      "oauth-callback",
      "oauth-callback",
      [],
      null,
      { "x-kasitek-oauth-proxy": "1" },
    );
    try {
      const value = parseLosslessJson(await response.text());
      if (response.ok) return value;
      if (value !== null && typeof value === "object" && !Array.isArray(value))
        return value;
    } catch {
      if (response.ok)
        throw new ApiError(
          502,
          "bad_gateway",
          "Agent Platform returned an invalid OAuth callback response",
        );
    }
    throw new ApiError(
      502,
      "bad_gateway",
      `Agent Platform OAuth callback failed with status ${response.status} ${response.statusText}`,
    );
  }
  async requestStream(
    path: string,
    org: string,
    actor: string,
    scopes: string[],
  ): Promise<Response> {
    const response = await this.send(
      "GET",
      path,
      org,
      actor,
      scopes,
      null,
      { accept: "text/event-stream" },
      false,
      true,
    );
    if (!response.ok) throw await this.mapStatus(response);
    return response;
  }
  async requestForwardedJson(
    path: string,
    providerSecret: string | null,
    body: unknown,
  ): Promise<unknown> {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref();
    try {
      const response = await (this.options.fetch ?? fetch)(
        this.baseUrl + path,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-kasitek-core-forward-secret": this.secret,
            ...(providerSecret?.trim()
              ? { "x-telegram-bot-api-secret-token": providerSecret }
              : {}),
            ...this.options.traceHeaders?.(),
          },
          body: canonicalJson(body),
          signal: controller.signal,
        },
      );
      return await this.parseResponse(response);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted)
        throw new ApiError(
          504,
          "gateway_timeout",
          "Agent Platform request timed out",
        );
      throw new ApiError(502, "bad_gateway", "Agent Platform request failed");
    } finally {
      clearTimeout(timer);
    }
  }
  async mapStatus(response: Response): Promise<ApiError> {
    let detail: Record<string, unknown> | null = null;
    try {
      const value = parseLosslessJson(await response.text());
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        const raw = value as Record<string, unknown>;
        if (
          (raw.error == null || typeof raw.error === "string") &&
          (raw.code == null || typeof raw.code === "string")
        )
          detail = raw;
      }
    } catch {}
    const message =
        typeof detail?.error === "string"
          ? detail.error
          : "Agent Platform request failed",
      code = typeof detail?.code === "string" ? detail.code : null;
    if (code !== null && knownCodes.has(code))
      return new ApiError(response.status, code, message);
    if (code === "conversation_handoff_active")
      return new ApiError(409, code, message);
    const map: Record<number, [number, string]> = {
      400: [400, "bad_request"],
      422: [400, "bad_request"],
      401: [401, "unauthorized"],
      403: [403, "forbidden"],
      404: [404, "not_found"],
      409: [409, "conflict"],
      408: [504, "gateway_timeout"],
      504: [504, "gateway_timeout"],
      503: [503, "service_unavailable"],
    };
    const [status, error] = map[response.status] ?? [502, "bad_gateway"];
    return new ApiError(
      status,
      error,
      status === 401 ? "Unauthorized" : message,
    );
  }
}
