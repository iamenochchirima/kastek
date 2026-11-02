import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { apiJson } from "../json.js";
import { listGrowthOperations } from "./policy.js";
import { auditGrowthAccess } from "./telemetry.js";
import { growthToolArguments, growthToolInputSchema } from "./transport.js";
import { CONTENT_APP_URI, CONTENT_APP_TOOL_NAME, contentMcpAppTool, contentMcpAppResourcesList, readContentMcpAppResource, invokeContentMcpAppControl, decorateContentMcpAppResult } from "./content-mcp-app.js";
import {
  confirmContentOperationReview, rejectContentOperationReview,
  executeGrowthOperation, getOperationReview, isContentPublicOperation,
  type OperationReviewRow,
} from "./reviews.js";

export const MCP_2026_VERSION = "2026-07-28";
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";
const MAX_FORM_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const STATE_DOMAIN = "growth-content-mcp-form-v1\0";
type JsonObject = Record<string, unknown>;
type FormMode = "core" | "openai";

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
type ConfirmationFailure = "state_shape" | "state_hmac" | "state_payload" | "state_expired" | "state_identity" | "state_arguments" | "state_review" | "form_capability" | "form_responses" | "form_id" | "decision_action" | "decision_schema";
class ContentConfirmationError extends ApiError {
  constructor(readonly confirmationReason: ConfirmationFailure) {
    super(409, "content_confirmation_invalid", "This content confirmation is invalid or expired. Prepare a fresh preview.");
  }
}
const invalidState = (reason: ConfirmationFailure = "state_payload") => new ContentConfirmationError(reason);

/** Diagnostic vocabulary is fixed: never log response keys, values, content or opaque state. */
export function mcpConfirmationResponseShape(params: JsonObject) {
  const responses = object(params.inputResponses) ? Object.values(params.inputResponses) : [];
  const first = responses.length === 1 && object(responses[0]) ? responses[0] : {};
  const content = object(first.content) ? first.content : {};
  const action = ["accept", "decline", "cancel"].includes(String(first.action)) ? String(first.action) : first.action === undefined ? "absent" : "other";
  return { state_present: typeof params.requestState === "string", responses_object: object(params.inputResponses),
    responses_count: Math.min(responses.length, 10), response_object: responses.length === 1 && object(responses[0]),
    response_error: object(first.error), response_result: object(first.result), response_action: action,
    content_object: object(first.content), content_count: Math.min(Object.keys(content).length, 10),
    confirm_boolean: typeof content.confirm === "boolean", decision_string: typeof content.decision === "string" };
}

export function isMcp2026Request(request: Pick<FastifyRequest, "headers" | "body">): boolean {
  const body = request.body;
  const params = object(body) && object(body.params) ? body.params : undefined;
  const meta = params && object(params._meta) ? params._meta : undefined;
  const header = request.headers["mcp-protocol-version"];
  return typeof header === "string" && /^\d{4}-\d{2}-\d{2}$/.test(header) && header >= MCP_2026_VERSION ||
    meta?.[VERSION_META] === MCP_2026_VERSION || object(body) && body.method === "server/discover";
}

/** Standard mirrored headers follow the 2026 HTTP binding, including encoded names. */
function decodedNameHeader(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[\x20-\x7e]+$/.test(value) || value.trim() !== value) return undefined;
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice(9, -2);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  return Buffer.from(decoded).equals(bytes) ? decoded : undefined;
}

/** Capabilities come from this protocol request, never a client-name or user-agent guess. */
export function mcpContentFormMode(capabilities: JsonObject, clientId: string | null): FormMode | null {
  const elicitation = capabilities.elicitation;
  if (!object(elicitation) || !object(elicitation.form)) return null;
  const extensions = object(capabilities.extensions) ? capabilities.extensions : {};
  const openai = extensions["openai/elicitation"];
  const registeredOpenAi = clientId !== null && /^https:\/\/chatgpt\.com\/oauth\/(?:[A-Za-z0-9_-]+\/)?client\.json$/.test(clientId);
  if (openai !== undefined || registeredOpenAi) {
    return object(openai) && object(openai.form) ? "openai" : null;
  }
  return "core";
}

interface ConfirmationState {
  version: 2;
  answerSchema: "choice_v1";
  reviewId: string;
  payloadDigest: string;
  operation: string;
  requestKey: string;
  argumentsDigest: string;
  principalKind: string;
  principalId: string;
  userId: string | null;
  organizationId: string;
  clientId: string | null;
  formId: string;
  expires: number;
}

function stateSecret(core: CoreContext): string {
  const secret = core.config.rawEnv.GROWTH_MCP_CONFIRMATION_SECRET;
  if (!secret || core.config.environment === "production" && Buffer.byteLength(secret) < 32)
    throw new ApiError(503, "content_confirmation_unavailable", "Content confirmation is not configured");
  return secret;
}

/** The host echoes opaque protocol state; the agent never receives an approval argument. */
export function sealMcpContentConfirmation(core: CoreContext, ctx: RequestContext, row: OperationReviewRow,
  args: JsonObject, now = Date.now()): string {
  const payload: ConfirmationState = {
    version: 2, answerSchema: "choice_v1", reviewId: row.id, payloadDigest: row.payloadDigest, operation: row.operation,
    requestKey: row.requestKey, argumentsDigest: hash({ name: row.operation, arguments: args }),
    principalKind: ctx.principal.kind, principalId: ctx.principal.id, userId: ctx.userId,
    organizationId: ctx.organizationId, clientId: ctx.clientId, formId: randomUUID(),
    expires: Math.min(+new Date(row.expiresAt), now + 5 * 60_000),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", stateSecret(core)).update(STATE_DOMAIN + encoded).digest("base64url");
  return `${encoded}.${mac}`;
}

export function readMcpContentConfirmation(core: CoreContext, ctx: RequestContext, value: unknown,
  operation: string, args: JsonObject, now = Date.now(), allowReceiptObservation = false): ConfirmationState {
  if (typeof value !== "string" || value.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw invalidState("state_shape");
  const [encoded, supplied] = value.split(".") as [string, string];
  const expected = createHmac("sha256", stateSecret(core)).update(STATE_DOMAIN + encoded).digest("base64url");
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw invalidState("state_hmac");
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); } catch { throw invalidState(); }
  if (!object(parsed) || parsed.version !== 2 || parsed.answerSchema !== "choice_v1" || typeof parsed.reviewId !== "string" ||
      typeof parsed.payloadDigest !== "string" || typeof parsed.requestKey !== "string" ||
      typeof parsed.formId !== "string" || typeof parsed.expires !== "number") throw invalidState("state_payload");
  if (!allowReceiptObservation && parsed.expires <= now) throw invalidState("state_expired");
  if (parsed.operation !== operation || parsed.argumentsDigest !== hash({ name: operation, arguments: args })) throw invalidState("state_arguments");
  if (parsed.principalKind !== ctx.principal.kind || parsed.principalId !== ctx.principal.id ||
      parsed.userId !== ctx.userId || parsed.organizationId !== ctx.organizationId || parsed.clientId !== ctx.clientId) throw invalidState("state_identity");
  return parsed as unknown as ConfirmationState;
}

function humanLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, first => first.toUpperCase());
}
function previewLines(value: unknown, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) return value.length ? value.flatMap(item => [indent + "•", ...previewLines(item, depth + 1)]) : [indent + "None"];
  if (object(value)) return Object.entries(value).flatMap(([key, item]) =>
    object(item) || Array.isArray(item) ? [indent + humanLabel(key) + ":", ...previewLines(item, depth + 1)]
      : [indent + humanLabel(key) + ": " + (item === null ? "None" : String(item))]);
  return [indent + String(value ?? "None")];
}
export function contentConfirmationMessage(row: OperationReviewRow): string | null {
  let preview: unknown;
  try { preview = JSON.parse(row.snapshot.preview ?? "null"); } catch { return null; }
  if (!object(preview)) return null;
  const message = "Confirm this exact content action.\n\n" + previewLines(preview).join("\n");
  // Never approve a shortened copy or omit destinations/media to fit a host form.
  return Buffer.byteLength(message) <= MAX_FORM_BYTES ? message : null;
}

export function mcpContentConfirmationDecision(response: unknown): "approve" | "reject" {
  if (!object(response) || !["accept", "decline", "cancel"].includes(String(response.action))) throw invalidState("decision_action");
  if (response.action !== "accept") return "reject";
  if (!object(response.content) || Object.keys(response.content).length !== 1 || !["confirm", "cancel"].includes(String(response.content.decision)) || typeof response.content.decision !== "string") throw invalidState("decision_schema");
  return response.content.decision === "confirm" ? "approve" : "reject";
}

function toolResult(value: JsonObject) {
  const output = JSON.parse(apiJson(value)) as JsonObject;
  const text = JSON.stringify(output);
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new ApiError(413, "operation_result_too_large", "Narrow the requested range or page size");
  return { resultType: "complete", content: [{ type: "text", text }], structuredContent: output, isError: value.state === "uncertain" };
}

/** A client without chat confirmation receives a blocked action, never a browser detour. */
export function sanitizeMcpChatResult(value: JsonObject): JsonObject {
  const clean = (item: unknown): unknown => Array.isArray(item) ? item.map(clean) : object(item)
    ? Object.fromEntries(Object.entries(item).filter(([key]) => key !== "reviewUrl").map(([key, entry]) => [key, clean(entry)])) : item;
  const output = clean(value) as JsonObject;
  if (["approval_required", "validation_required"].includes(String(value.state))) {
    // A serialized continuation may contain the old browser-review field. It cannot authorize
    // anything on an unsupported client, so expose only its safe receipt identity here.
    if (object(output.result) && output.result.encoding === "json") delete output.result;
    return { ...output, state: "confirmation_unavailable", message: "This client cannot confirm this content action in chat. Use a client with in-chat confirmation support." };
  }
  return output;
}

export async function growthMcpToolList(core: CoreContext, context: RequestContext, appUiSupported = false) {
  return auditGrowthAccess(core, context, "discovery", async () => {
    const permitted = await listGrowthOperations(core, context);
    const canConfirm = appUiSupported && permitted.some(operation => isContentPublicOperation(operation.name));
    return { tools: [ ...permitted.map(operation => ({
      name: operation.name, description: operation.description,
      inputSchema: growthToolInputSchema(operation), outputSchema: operation.outputSchema,
      annotations: { readOnlyHint: operation.effect === "read", destructiveHint: operation.effect === "destructive",
        idempotentHint: operation.idempotency === "required", openWorldHint: operation.effect === "external_effect" },
      ...(appUiSupported && (isContentPublicOperation(operation.name) || operation.name === "content.actions.preview")
        ? { _meta: { ui: { resourceUri: CONTENT_APP_URI, visibility: ["model", "app"] }, "openai/outputTemplate": CONTENT_APP_URI } } : {}),
    })), ...(canConfirm ? [contentMcpAppTool()] : []) ] };
  });
}

function appToolResult(result: Awaited<ReturnType<typeof decorateContentMcpAppResult>>) {
  if (Buffer.byteLength(apiJson(result)) > 2 * 1024 * 1024) throw new ApiError(413, "operation_result_too_large", "Narrow the requested content preview");
  return { resultType: "complete", ...result };
}

async function callTool(core: CoreContext, context: RequestContext, params: JsonObject, mode: FormMode | null, log: FastifyRequest["log"], appUiSupported: boolean) {
  if (typeof params.name !== "string" || params.name.length > 200 ||
      params.arguments !== undefined && !object(params.arguments)) throw new ApiError(422, "operation_arguments_invalid", "Invalid tool arguments");
  const operation = params.name;
  const args = params.arguments as JsonObject | undefined ?? {};
  if (operation === CONTENT_APP_TOOL_NAME) {
    if (!appUiSupported) throw new ApiError(409, "content_confirmation_unavailable", "This client does not support in-chat content confirmation");
    return appToolResult(await invokeContentMcpAppControl(core, context, args));
  }
  const invocation = growthToolArguments(args);
  if (params.inputResponses !== undefined || params.requestState !== undefined) {
    if (!mode || !isContentPublicOperation(operation)) throw invalidState("form_capability");
    const state = readMcpContentConfirmation(core, context, params.requestState, operation, args, Date.now(), true);
    if (!object(params.inputResponses) || Object.keys(params.inputResponses).length !== 1) throw invalidState("form_responses");
    if (!Object.hasOwn(params.inputResponses, state.formId)) throw invalidState("form_id");
    const response = params.inputResponses[state.formId];
    const row = await getOperationReview(core, context, state.reviewId);
    if (row.operation !== operation || row.payloadDigest !== state.payloadDigest || row.requestKey !== state.requestKey) throw invalidState("state_review");
    if (["succeeded", "executing", "uncertain"].includes(row.state))
      return toolResult(await executeGrowthOperation(core, context, { operation, ...invocation, requestId: row.requestKey, reviewId: row.id }));
    if (state.expires <= Date.now()) throw invalidState("state_expired");
    // A host's explicit protocol error cannot confirm an action. Preserve its owned review fallback.
    if (object(response) && object(response.error) && typeof response.error.code === "number" &&
        [-32601, -32602].includes(response.error.code) && response.action === undefined)
      return toolResult(sanitizeMcpChatResult(await executeGrowthOperation(core, context,
        { operation, ...invocation, requestId: row.requestKey, reviewId: row.id, prepareOnly: true })));
    if (object(response) && response.action === "accept" && object(response.content) &&
        Object.keys(response.content).length === 0 && response.error === undefined && response.result === undefined) {
      // Some hosts submit the empty core schema without rendering the extended form.
      // Reauthorize the unchanged owned action, but never consume approval or dispatch an effect.
      const pending = await executeGrowthOperation(core, context,
        { operation, ...invocation, requestId: row.requestKey, reviewId: row.id, prepareOnly: true });
      if (pending.state !== "approval_required") return toolResult(pending);
      log.warn({ event: "growth.mcp.confirmation.unavailable", protocol_version: MCP_2026_VERSION,
        reason: "missing_required_answer", confirmation_shape: mcpConfirmationResponseShape(params) },
      "MCP client did not return required content confirmation");
      return toolResult(sanitizeMcpChatResult(pending));
    }
    const decision = mcpContentConfirmationDecision(response);
    if (decision === "reject") {
      await rejectContentOperationReview(core, context, row.id, row.payloadDigest, "mcp_form");
      return toolResult({ state: "rejected", message: "Content action cancelled. Nothing was executed." });
    }
    await confirmContentOperationReview(core, context, row.id, row.payloadDigest, "mcp_form");
    return toolResult(await executeGrowthOperation(core, context, { operation, ...invocation, requestId: row.requestKey, reviewId: row.id }));
  }
  const value = await executeGrowthOperation(core, context, { operation, ...invocation });
  if (appUiSupported && (isContentPublicOperation(operation) || operation === "content.actions.preview"))
    return appToolResult(await decorateContentMcpAppResult(core, context, operation, args, value));
  if (value.state !== "approval_required" || !isContentPublicOperation(operation) || invocation.continuation) return toolResult(value);
  if (!mode) return toolResult(sanitizeMcpChatResult(value));
  const review = object(value.review) ? value.review : undefined;
  if (!review || typeof review.id !== "string") return toolResult(value);
  const row = await getOperationReview(core, context, review.id);
  const preview = JSON.parse(row.snapshot.preview ?? "null") as unknown;
  if (object(preview) && object(preview.validation) && preview.validation.ready === false)
    return toolResult({ ...value, state: "validation_required", message: "Fix the listed validation issues before confirming this content action." });
  const message = contentConfirmationMessage(row);
  if (!message) return toolResult(sanitizeMcpChatResult(value));
  const requestState = sealMcpContentConfirmation(core, context, row, args);
  const sealed = readMcpContentConfirmation(core, context, requestState, operation, args);
  const requestedSchema = { type: "object", properties: { decision: { type: "string", title: "Content action", enum: ["confirm", "cancel"], default: "cancel" } }, required: ["decision"] };
  const formParams = mode === "openai" ? { mode: "form", message,
    requestedSchema: { type: "object", properties: {} },
    _meta: { "openai/elicitation": { requestedSchema } },
  } : { mode: "form", message, requestedSchema };
  return { resultType: "input_required", requestState,
    inputRequests: { [sealed.formId]: { method: "elicitation/create", params: formParams } } };
}

/** MCP2026 MRTR is an independent JSON round trip, leaving legacy SDK sessions unchanged. */
export async function handleGrowthMcp2026(core: CoreContext, context: RequestContext, request: FastifyRequest, reply: FastifyReply) {
  const body = request.body;
  const id = object(body) && (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;
  const fail = (code: number, message: string, status = 200, data?: JsonObject) => reply.code(status).send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  if (!object(body) || body.jsonrpc !== "2.0" || id === null ||
      typeof body.method !== "string" || !object(body.params) || !object(body.params._meta)) return fail(-32600, "Invalid MCP request", 400);
  const params = body.params;
  const meta = params._meta as JsonObject;
  if (typeof meta[VERSION_META] !== "string" || meta[VERSION_META] !== request.headers["mcp-protocol-version"])
    return fail(-32020, "MCP protocol metadata and header must agree", 400);
  if (meta[VERSION_META] !== MCP_2026_VERSION)
    return fail(-32022, "Unsupported MCP protocol version", 400, { supported: [MCP_2026_VERSION, "2025-11-25"], requested: meta[VERSION_META] });
  if (request.headers["mcp-method"] !== body.method)
    return fail(-32020, "MCP method metadata and header must agree", 400);
  const needsName = ["tools/call", "resources/read", "prompts/get"].includes(body.method);
  const name = body.method === "resources/read" ? params.uri : params.name;
  if (needsName && (typeof name !== "string" || decodedNameHeader(request.headers["mcp-name"]) !== name))
    return fail(-32020, "MCP name metadata and header must agree", 400);
  if (!object(meta[CAPABILITIES_META])) return fail(-32602, "MCP client capabilities are required", 400);
  const mode = mcpContentFormMode(meta[CAPABILITIES_META] as JsonObject, context.clientId);
  const capabilities = meta[CAPABILITIES_META] as JsonObject;
  const appUi = object(capabilities.extensions) ? capabilities.extensions["io.modelcontextprotocol/ui"] : undefined;
  const appUiDeclared = object(appUi);
  const appUiSupported = appUiDeclared && Array.isArray(appUi.mimeTypes) && appUi.mimeTypes.includes("text/html;profile=mcp-app");
  request.log.info({ event: "growth.mcp.capabilities", protocol_version: MCP_2026_VERSION,
    content_form_supported: mode !== null, extended_form_supported: mode === "openai",
    app_ui_declared: appUiDeclared, app_ui_supported: appUiSupported }, "Growth MCP request capabilities");
  reply.header("Cache-Control", "no-store");
  try {
    let result: unknown;
    switch (body.method) {
      case "server/discover":
        result = { resultType: "complete", supportedVersions: [MCP_2026_VERSION, "2025-11-25"], capabilities: { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/ui": {} } },
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "kasitek-growth", version: "1.2.0" } } };
        break;
      case "ping": result = { resultType: "complete" }; break;
      case "resources/list": result = { resultType: "complete", ...await auditGrowthAccess(core, context, "content.review.resources", async () => contentMcpAppResourcesList()) }; break;
      case "resources/read":
        if (typeof params.uri !== "string") return fail(-32602, "A resource URI is required");
        if (params.uri !== CONTENT_APP_URI) return fail(-32002, "Resource not found", 404);
        result = { resultType: "complete", ...await auditGrowthAccess(core, context, "content.review.resource", async () => readContentMcpAppResource(params.uri as string, core.config.publicApiUrl)) };
        request.log.info({ event: "growth.mcp.resource.read", resource_version: "content-review-v1" }, "Growth content review resource read"); break;
      case "tools/list": result = { resultType: "complete", ...await growthMcpToolList(core, context, appUiSupported) }; break;
      case "tools/call": result = await callTool(core, context, params, mode, request.log, appUiSupported); break;
      default: return fail(-32601, "MCP method not supported", 404);
    }
    return reply.send({ jsonrpc: "2.0", id, result });
  } catch (error) {
    const value = { code: error instanceof ApiError ? error.code : "internal_error",
      message: error instanceof ApiError ? error.message : "Could not complete the Growth operation" };
    request.log.warn({ event: "growth.operation.failed", protocol_version: MCP_2026_VERSION,
      error_type: value.code,
      ...(error instanceof ContentConfirmationError ? { confirmation_reason: error.confirmationReason,
        confirmation_shape: mcpConfirmationResponseShape(params) } : {}) }, "Growth MCP request failed");
    return reply.send({ jsonrpc: "2.0", id, result: { resultType: "complete", isError: true,
      content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value } });
  }
}
