import Fastify, { type FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { FixedWindowRateLimiter } from "./rate-limit";
import {
  firstHeader,
  inspectMcpRequest,
  MCP_COMPATIBILITY_PROTOCOL_VERSION,
  MCP_STATELESS_PROTOCOL_VERSION,
  mcpEnvelopeSchema,
  McpProtocolError,
  validateStatelessRequest,
} from "../mcp/protocol";

const MAX_MCP_REQUEST_BYTES = 256 * 1024;
const MAX_MCP_RESPONSE_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const SUPPORTED_PROTOCOL_VERSIONS: ReadonlySet<string> = new Set([MCP_STATELESS_PROTOCOL_VERSION, MCP_COMPATIBILITY_PROTOCOL_VERSION]);

interface GatewayMetrics {
  requests: number;
  responses: number;
  errors: number;
  statelessRequests: number;
  compatibilityRequests: number;
  protocolErrors: number;
  completeResponses: number;
  taskResponses: number;
  errorResponses: number;
  methodCounts: Record<"server_discover" | "tools_list" | "tools_call" | "tasks" | "other", number>;
  inFlight: number;
  totalLatencyMs: number;
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error("upstream_response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("upstream_response_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function buildGateway(input: {
  agentPlatformUrl: string;
  sharedSecret?: string;
  environment?: "development" | "test" | "production";
  enabled?: boolean;
  rateLimitPerWindow?: number;
  preAuthRateLimitPerWindow?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxKeys?: number;
  upstreamTimeoutMs?: number;
  allowedOrigins?: string[];
  statelessEnabled?: boolean;
}): FastifyInstance {
  if (input.environment === "production" && !input.sharedSecret?.trim()) {
    throw new Error("AGENT_GATEWAY_SHARED_SECRET is required in production");
  }
  const upstreamTimeoutMs = input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const app = Fastify({ logger: false, bodyLimit: MAX_MCP_REQUEST_BYTES, requestTimeout: upstreamTimeoutMs });
  const enabled = input.enabled ?? true;
  const statelessEnabled = input.statelessEnabled ?? true;
  const windowMs = input.rateLimitWindowMs ?? 60_000;
  const authenticatedLimiter = new FixedWindowRateLimiter(input.rateLimitPerWindow ?? 120, windowMs, input.rateLimitMaxKeys ?? 10_000);
  const preAuthLimiter = new FixedWindowRateLimiter(input.preAuthRateLimitPerWindow ?? 60, windowMs, input.rateLimitMaxKeys ?? 10_000);
  const allowedOrigins = new Set((input.allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean));
  const metrics: GatewayMetrics = {
    requests: 0,
    responses: 0,
    errors: 0,
    statelessRequests: 0,
    compatibilityRequests: 0,
    protocolErrors: 0,
    completeResponses: 0,
    taskResponses: 0,
    errorResponses: 0,
    methodCounts: { server_discover: 0, tools_list: 0, tools_call: 0, tasks: 0, other: 0 },
    inFlight: 0,
    totalLatencyMs: 0,
  };

  const jsonRpcError = (
    reply: { code: (status: number) => { send: (payload: unknown) => unknown } },
    code: number,
    message: string,
    data?: unknown,
    statusOverride?: number,
  ) => reply.code(statusOverride ?? (code === -32029 ? 429 : code === -32003 ? 401 : code === -32602 || code === -32020 || code === -32022 ? 400 : 503)).send({
    jsonrpc: "2.0",
    id: null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  app.setErrorHandler((error, request, reply) => {
    if (request.url === "/mcp" && request.method === "POST") {
      const tooLarge = (error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE";
      return reply.code(tooLarge ? 413 : ((error as { statusCode?: number }).statusCode ?? 400)).send({
        jsonrpc: "2.0",
        id: null,
        error: { code: tooLarge ? -32011 : -32000, message: tooLarge ? "mcp_request_too_large" : "invalid_mcp_request" },
      });
    }
    return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: "gateway_error" });
  });

  app.get("/health", async () => ({ status: "ok", service: "agent-gateway" }));
  app.get("/health/ready", async (_request, reply) => {
    if (!enabled) return reply.code(503).send({ status: "not_ready", reason: "mcp_gateway_disabled" });
    try {
      const response = await fetch(`${input.agentPlatformUrl.replace(/\/$/, "")}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return reply.code(503).send({ status: "not_ready", reason: "agent_platform_unready" });
      return { status: "ready", service: "agent-gateway" };
    } catch {
      return reply.code(503).send({ status: "not_ready", reason: "agent_platform_unreachable" });
    }
  });
  app.get("/metrics", async (_request, reply) => {
    const averageLatencyMs = metrics.responses ? metrics.totalLatencyMs / metrics.responses : 0;
    return reply.type("text/plain; version=0.0.4").send([
      `kasitek_gateway_requests_total ${metrics.requests}`,
      `kasitek_gateway_responses_total ${metrics.responses}`,
      `kasitek_gateway_errors_total ${metrics.errors}`,
      `kasitek_gateway_stateless_requests_total ${metrics.statelessRequests}`,
      `kasitek_gateway_compatibility_requests_total ${metrics.compatibilityRequests}`,
      `kasitek_gateway_protocol_errors_total ${metrics.protocolErrors}`,
      `kasitek_gateway_complete_responses_total ${metrics.completeResponses}`,
      `kasitek_gateway_task_responses_total ${metrics.taskResponses}`,
      `kasitek_gateway_error_responses_total ${metrics.errorResponses}`,
      `kasitek_gateway_method_server_discover_total ${metrics.methodCounts.server_discover}`,
      `kasitek_gateway_method_tools_list_total ${metrics.methodCounts.tools_list}`,
      `kasitek_gateway_method_tools_call_total ${metrics.methodCounts.tools_call}`,
      `kasitek_gateway_method_tasks_total ${metrics.methodCounts.tasks}`,
      `kasitek_gateway_method_other_total ${metrics.methodCounts.other}`,
      `kasitek_gateway_in_flight ${metrics.inFlight}`,
      `kasitek_gateway_average_latency_ms ${averageLatencyMs.toFixed(3)}`,
      "",
    ].join("\n"));
  });
  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource: "/mcp",
    authorization_servers: [],
    scopes_supported: ["mcp:read", "mcp:write"],
    bearer_methods_supported: ["header"],
    installation_token_exchange_endpoint: "/v1/installation-tokens/exchange",
  }));
  app.get("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send({ error: "streaming_not_supported" }));
  app.delete("/mcp", async (_request, reply) => reply.code(405).header("allow", "POST").send({ error: "sessions_not_supported" }));
  app.post("/mcp", async (request, reply) => {
    const startedAt = Date.now();
    metrics.requests += 1;
    metrics.inFlight += 1;
    const correlationId = typeof request.headers["x-correlation-id"] === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(request.headers["x-correlation-id"])
      ? request.headers["x-correlation-id"]
      : randomUUID();
    reply.header("x-correlation-id", correlationId);
    const finish = (error = false) => {
      metrics.inFlight = Math.max(0, metrics.inFlight - 1);
      metrics.responses += 1;
      if (error) metrics.errors += 1;
      metrics.totalLatencyMs += Date.now() - startedAt;
    };
    // Count all protocol/transport failures, including bounded client errors
    // and rate limits, while keeping the response body free of credentials.
    reply.raw.once("finish", () => finish(reply.statusCode >= 400));
    if (!enabled) return jsonRpcError(reply, -32030, "mcp_gateway_disabled");
    const origin = firstHeader(request.headers, "origin");
    if (origin && (!allowedOrigins.size || !allowedOrigins.has(origin))) {
      return reply.code(403).send({ error: "origin_not_allowed" });
    }
    const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : "";
    const rateKey = authorization.startsWith("Bearer ")
      ? `credential:${createHash("sha256").update(authorization).digest("hex")}`
      : `network:${request.ip}`;
    const decision = (authorization ? authenticatedLimiter : preAuthLimiter).consume(rateKey);
    if (!decision.allowed) {
      reply.header("retry-after", String(decision.retryAfterSeconds));
      return jsonRpcError(reply, -32029, "rate_limited");
    }
    const parsedBody = mcpEnvelopeSchema.safeParse(request.body);
    if (!parsedBody.success) {
      return jsonRpcError(reply, -32600, "invalid_mcp_request", undefined, 400);
    }
    const body = parsedBody.data;
    if (body.method === "server/discover") metrics.methodCounts.server_discover += 1;
    else if (body.method === "tools/list") metrics.methodCounts.tools_list += 1;
    else if (body.method === "tools/call") metrics.methodCounts.tools_call += 1;
    else if (body.method.startsWith("tasks/")) metrics.methodCounts.tasks += 1;
    else metrics.methodCounts.other += 1;
    const inspection = inspectMcpRequest(body, request.headers);
    if (inspection.era === "stateless_2026") metrics.statelessRequests += 1;
    else metrics.compatibilityRequests += 1;
    const requestedProtocol = firstHeader(request.headers, "mcp-protocol-version");
    if (!SUPPORTED_PROTOCOL_VERSIONS.has(requestedProtocol ?? MCP_COMPATIBILITY_PROTOCOL_VERSION)
      && inspection.era === "pre_2026_compatibility") {
      metrics.protocolErrors += 1;
      reply.header("mcp-protocol-version", MCP_COMPATIBILITY_PROTOCOL_VERSION);
      return jsonRpcError(reply, -32602, "unsupported_mcp_protocol_version");
    }
    if (inspection.era === "stateless_2026") {
      if (!statelessEnabled) {
        metrics.protocolErrors += 1;
        reply.header("mcp-protocol-version", MCP_COMPATIBILITY_PROTOCOL_VERSION);
        return jsonRpcError(reply, -32022, "Unsupported protocol version", {
          supported: [MCP_COMPATIBILITY_PROTOCOL_VERSION],
          requested: inspection.bodyProtocolVersion ?? requestedProtocol ?? MCP_STATELESS_PROTOCOL_VERSION,
        }, 400);
      }
      try {
        validateStatelessRequest({ body, headers: request.headers, transport: "http" });
      } catch (error) {
        if (!(error instanceof McpProtocolError)) throw error;
        metrics.protocolErrors += 1;
        reply.header("mcp-protocol-version", MCP_STATELESS_PROTOCOL_VERSION);
        return reply.code(error.statusCode).send({
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: {
            code: error.rpcCode,
            message: error.message,
            ...(error.data === undefined ? {} : { data: error.data }),
          },
        });
      }
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: firstHeader(request.headers, "accept") ?? "application/json, text/event-stream",
    };
    if (typeof request.headers.authorization === "string") headers.authorization = request.headers.authorization;
    if (requestedProtocol) headers["mcp-protocol-version"] = requestedProtocol;
    for (const [name, value] of Object.entries(request.headers)) {
      if (!name.toLowerCase().startsWith("mcp-param-") || typeof value !== "string") continue;
      headers[name.toLowerCase()] = value;
    }
    if (inspection.era === "stateless_2026") {
      const method = firstHeader(request.headers, "mcp-method");
      const name = firstHeader(request.headers, "mcp-name");
      if (method) headers["mcp-method"] = method;
      if (name) headers["mcp-name"] = name;
    }
    if (input.sharedSecret) headers["x-agent-gateway-secret"] = input.sharedSecret;

    const controller = new AbortController();
    const onDisconnect = () => controller.abort();
    const onResponseClose = () => {
      // A response close before `finish` means the client disconnected while
      // the upstream request was still in flight. A normal completed response
      // emits `finish` first and is therefore not aborted.
      if (!reply.raw.writableFinished) controller.abort();
    };
    request.raw.once("aborted", onDisconnect);
    reply.raw.once("close", onResponseClose);
    try {
      const response = await fetch(`${input.agentPlatformUrl.replace(/\/$/, "")}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(upstreamTimeoutMs)]),
      });
      if (response.status >= 500) throw new Error("agent_platform_upstream_failure");
      const payload = await readBoundedResponse(response, MAX_MCP_RESPONSE_BYTES);
      const upstreamProtocol = response.headers.get("mcp-protocol-version");
      if (upstreamProtocol) reply.header("mcp-protocol-version", upstreamProtocol);
      if (response.status >= 400) {
        metrics.errorResponses += 1;
      } else {
        try {
          const decoded = JSON.parse(payload) as { result?: { resultType?: unknown }; error?: unknown };
          if (decoded.error !== undefined) metrics.errorResponses += 1;
          else if (decoded.result?.resultType === "task") metrics.taskResponses += 1;
          else metrics.completeResponses += 1;
        } catch {
          // Non-JSON streams are bounded and passed through without metric
          // classification; the gateway does not log or inspect their data.
        }
      }
      return reply.code(response.status).header("content-type", response.headers.get("content-type") ?? "application/json").send(payload);
    } catch (error) {
      const message = error instanceof Error && error.message === "upstream_response_too_large" ? error.message : "agent_platform_unavailable";
      return reply.code(502).send({ jsonrpc: "2.0", id: null, error: { code: -32000, message } });
    } finally {
      request.raw.off("aborted", onDisconnect);
      reply.raw.off("close", onResponseClose);
    }
  });
  return app;
}
