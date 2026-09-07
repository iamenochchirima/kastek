import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  callRemoteMcpTool,
  discoverRemoteMcpTools,
  remoteMcpToolsSchema,
  validateRemoteMcpEndpoint,
  type RemoteMcpTool,
} from "./remote";
import { MCP_SUPPORTED_PROTOCOL_VERSIONS } from "./protocol";
import { redactSensitiveValue } from "../tools/redaction";
import {
  DurableOperationCoordinator,
  fingerprintOperationRequest,
  type DurableOperationRecord,
} from "../operations/durable-operation";

const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_SCHEMA_BYTES = 10_485_760;
const MAX_RESULT_BYTES = 2_097_152;
const MAX_TOOLS = 100;

const identifierSchema = z.string().trim().min(1).max(160);
const scopeSchema = z.object({
  organizationId: identifierSchema,
  agentVersionId: identifierSchema,
}).strict();

const operationLimitsSchema = z.object({
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS),
  maxResponseBytes: z.number().int().min(1_024).max(MAX_RESPONSE_BYTES),
  maxSchemaBytes: z.number().int().min(256).max(MAX_SCHEMA_BYTES),
  maxResultBytes: z.number().int().min(32).max(MAX_RESULT_BYTES),
  maxTools: z.number().int().min(1).max(MAX_TOOLS),
}).strict();

export type McpOperationScope = z.infer<typeof scopeSchema>;
export type McpOperationLimits = z.infer<typeof operationLimitsSchema>;
export type McpSnapshotState = "discovered" | "published";
export type McpOperationName = "discover" | "call";
export type McpFailureOutcome = "retryable" | "terminal" | "unknown";

export const DEFAULT_MCP_OPERATION_LIMITS: McpOperationLimits = Object.freeze({
  timeoutMs: 15_000,
  maxResponseBytes: 1_048_576,
  maxSchemaBytes: 1_000_000,
  maxResultBytes: 256_000,
  maxTools: MAX_TOOLS,
});

const snapshotBodySchema = z.object({
  scope: scopeSchema,
  serverId: identifierSchema,
  revision: z.number().int().positive(),
  endpointUrl: z.string().trim().url().max(2_000),
  protocolVersion: z.string().trim().min(1).max(80),
  state: z.enum(["discovered", "published"]),
  tools: remoteMcpToolsSchema,
  limits: operationLimitsSchema,
}).strict();

export const mcpServerSnapshotSchema = snapshotBodySchema.extend({
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

export type McpServerSnapshotBody = z.infer<typeof snapshotBodySchema>;
export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;

export interface McpDiscoveryInput {
  scope: McpOperationScope;
  serverId: string;
  revision: number;
  endpointUrl: string;
  authorizationToken?: string;
  limits?: Partial<McpOperationLimits>;
  environment?: "development" | "test" | "production";
  operationId?: string;
  signal?: AbortSignal;
}

export interface McpCallInput {
  scope: McpOperationScope;
  snapshot: McpServerSnapshot;
  toolName: string;
  argumentsValue: Record<string, unknown>;
  authorizationToken?: string;
  operationId?: string;
  environment?: "development" | "test" | "production";
  signal?: AbortSignal;
}

export interface RemoteMcpAdapterInput {
  endpointUrl: string;
  authorizationToken?: string;
  timeoutMs: number;
  maxResponseBytes: number;
  environment: "development" | "test" | "production";
}

export interface McpRemoteAdapter {
  discover(input: RemoteMcpAdapterInput, signal: AbortSignal): Promise<{
    protocolVersion: string;
    tools: RemoteMcpTool[];
  }>;
  call(input: RemoteMcpAdapterInput & {
    toolName: string;
    argumentsValue: Record<string, unknown>;
  }, signal: AbortSignal): Promise<unknown>;
}

/** Adapter over the existing remote MCP implementation. */
export class RemoteMcpAdapter implements McpRemoteAdapter {
  public discover(input: RemoteMcpAdapterInput, signal: AbortSignal): Promise<{ protocolVersion: string; tools: RemoteMcpTool[] }> {
    return discoverRemoteMcpTools({ ...input, signal });
  }

  public call(input: RemoteMcpAdapterInput & { toolName: string; argumentsValue: Record<string, unknown> }, signal: AbortSignal): Promise<unknown> {
    return callRemoteMcpTool({ ...input, signal });
  }
}

export interface McpOperationEvidence {
  evidenceVersion: "mcp.operation.v1";
  operationId: string;
  operation: McpOperationName;
  scope: McpOperationScope;
  serverId: string;
  snapshotChecksum?: string;
  toolName?: string;
  argumentsHash?: string;
  outcome: "success" | McpFailureOutcome;
  errorCode?: string;
  durationMs: number;
  responseBytes?: number;
  schemaBytes?: number;
  toolCount?: number;
  resultTruncated?: boolean;
}

export interface McpOperationFailure {
  code: string;
  outcome: McpFailureOutcome;
  /** Stable, non-provider-specific text. Raw provider errors never cross this seam. */
  message: string;
}

export type McpOperationResult<T> =
  | { ok: true; outcome: "success"; value: T; evidence: McpOperationEvidence }
  | { ok: false; outcome: McpFailureOutcome; error: McpOperationFailure; evidence: McpOperationEvidence };

export interface McpDiscoveryValue {
  snapshot: McpServerSnapshot;
  protocolVersion: string;
  tools: RemoteMcpTool[];
}

export interface McpCallValue {
  result: unknown;
  resultBytes: number;
  resultTruncated: boolean;
}

export interface McpOperationCoordinatorOptions {
  adapter?: McpRemoteAdapter;
  limits?: Partial<McpOperationLimits>;
  environment?: "development" | "test" | "production";
  onEvidence?: (evidence: McpOperationEvidence) => void | Promise<void>;
  /** Optional durable store. Without it the boundary remains host-neutral for unit tests. */
  durableOperations?: DurableOperationCoordinator;
}

class McpBoundaryFault extends Error {
  public constructor(
    public readonly code: string,
    public readonly outcome: McpFailureOutcome,
  ) {
    super(code);
    this.name = "McpBoundaryFault";
  }
}

/**
 * The only module callers need to know for a remote MCP operation. It turns
 * mutable provider state and unbounded remote payloads into a small, typed
 * operation result with safe evidence.
 */
export class McpOperationCoordinator {
  private readonly adapter: McpRemoteAdapter;
  private readonly defaults: McpOperationLimits;
  private readonly environment: "development" | "test" | "production";
  private readonly onEvidence?: (evidence: McpOperationEvidence) => void | Promise<void>;
  private readonly durableOperations?: DurableOperationCoordinator;

  public constructor(options: McpOperationCoordinatorOptions = {}) {
    this.adapter = options.adapter ?? new RemoteMcpAdapter();
    this.defaults = resolveLimits(options.limits);
    this.environment = options.environment ?? "production";
    this.onEvidence = options.onEvidence;
    this.durableOperations = options.durableOperations;
  }

  public async discover(input: McpDiscoveryInput): Promise<McpOperationResult<McpDiscoveryValue>> {
    const operationId = operationIdFrom(input.operationId);
    const scope = scopeForEvidence(input.scope);
    const serverId = safeIdentifier(input.serverId, "unknown-server");
    const startedAt = performance.now();
    let durableOperationId: string | undefined;
    const evidenceBase = { evidenceVersion: "mcp.operation.v1" as const, operationId, operation: "discover" as const, scope, serverId };

    try {
      const parsedScope = parseScope(input.scope);
      const limits = safeLimits(input.limits, this.defaults);
      const parsedInput = discoveryInputSchema.parse({
        ...input,
        scope: parsedScope,
        serverId,
        limits,
        environment: input.environment ?? this.environment,
      });
      const endpoint = validateRemoteMcpEndpoint(parsedInput.endpointUrl, parsedInput.environment);
      const durable = await this.prepareDurableOperation({
        operationId,
        scope: parsedInput.scope,
        operationKey: `${operationId}:discover`,
        request: { serverId: parsedInput.serverId, revision: parsedInput.revision, endpointUrl: endpoint.toString(), limits },
      });
      if (durable.outcome === "new") durableOperationId = durable.operationId;
      if (durable.outcome === "replay") return durable.result as McpOperationResult<McpDiscoveryValue>;
      if (durable.outcome === "blocked") return this.durableBlockedResult(evidenceBase, startedAt, durable.operation);
      const remote = await this.runWithCancellation(
        (signal) => this.adapter.discover({
          endpointUrl: endpoint.toString(),
          authorizationToken: parsedInput.authorizationToken,
          timeoutMs: limits.timeoutMs,
          maxResponseBytes: limits.maxResponseBytes,
          environment: parsedInput.environment,
        }, signal),
        limits.timeoutMs,
        parsedInput.signal,
      );
      const protocolVersion = validateProtocolVersion(remote.protocolVersion);
      const tools = boundToolSchemas(remote.tools, limits);
      const snapshot = createMcpServerSnapshot({
        scope: parsedInput.scope,
        serverId: parsedInput.serverId,
        revision: parsedInput.revision,
        endpointUrl: endpoint.toString(),
        protocolVersion,
        state: "discovered",
        tools,
        limits,
      });
      const evidence = this.finishEvidence({
        ...evidenceBase,
        outcome: "success",
        durationMs: elapsedMs(startedAt),
        schemaBytes: toolSchemaBytes(tools),
        toolCount: tools.length,
      });
      const value = { snapshot, protocolVersion, tools };
      await this.completeDurableOperation(durable.operationId, { value, evidence });
      return { ok: true, outcome: "success", value, evidence };
    } catch (error) {
      await this.failDurableOperation(durableOperationId, error);
      return this.failureResult(evidenceBase, startedAt, error);
    }
  }

  public async call(input: McpCallInput): Promise<McpOperationResult<McpCallValue>> {
    const operationId = operationIdFrom(input.operationId);
    const scope = scopeForEvidence(input.scope);
    const snapshotCandidate = input.snapshot as Partial<McpServerSnapshot> | undefined;
    const serverId = safeIdentifier(snapshotCandidate?.serverId, "unknown-server");
    const snapshotChecksum = typeof snapshotCandidate?.checksum === "string" ? snapshotCandidate.checksum : undefined;
    const argumentsHash = hashValue(input.argumentsValue);
    const evidenceBase = {
      evidenceVersion: "mcp.operation.v1" as const,
      operationId,
      operation: "call" as const,
      scope,
      serverId,
      ...(snapshotChecksum ? { snapshotChecksum } : {}),
      ...(typeof input.toolName === "string" && input.toolName.trim() ? { toolName: input.toolName.trim().slice(0, 160) } : {}),
      argumentsHash,
    };
    const startedAt = performance.now();
    let durableOperationId: string | undefined;

    try {
      const parsedScope = parseScope(input.scope);
      const snapshot = validateMcpServerSnapshot(input.snapshot, parsedScope, input.environment ?? this.environment);
      const limits = snapshot.limits;
      const toolName = toolNameSchema.parse(input.toolName);
      const tool = snapshot.tools.find((candidate) => candidate.name === toolName);
      if (!tool) throw new McpBoundaryFault("MCP_TOOL_NOT_IN_SNAPSHOT", "terminal");
      const durable = await this.prepareDurableOperation({
        operationId,
        scope: parsedScope,
        operationKey: `${operationId}:call`,
        request: { serverId: snapshot.serverId, snapshotChecksum: snapshot.checksum, toolName, arguments: input.argumentsValue },
      });
      if (durable.outcome === "new") durableOperationId = durable.operationId;
      if (durable.outcome === "replay") return durable.result as McpOperationResult<McpCallValue>;
      if (durable.outcome === "blocked") return this.durableBlockedResult(evidenceBase, startedAt, durable.operation);
      const result = await this.runWithCancellation(
        (signal) => this.adapter.call({
          endpointUrl: snapshot.endpointUrl,
          authorizationToken: input.authorizationToken,
          timeoutMs: limits.timeoutMs,
          maxResponseBytes: limits.maxResponseBytes,
          environment: input.environment ?? this.environment,
          toolName,
          argumentsValue: input.argumentsValue,
        }, signal),
        limits.timeoutMs,
        input.signal,
      );
      const bounded = boundToolResult(result, limits.maxResultBytes);
      const evidence = this.finishEvidence({
        ...evidenceBase,
        snapshotChecksum: snapshot.checksum,
        toolName,
        outcome: "success",
        durationMs: elapsedMs(startedAt),
        responseBytes: bounded.resultBytes,
        resultTruncated: bounded.resultTruncated,
      });
      await this.completeDurableOperation(durable.operationId, { value: bounded, evidence });
      return { ok: true, outcome: "success", value: bounded, evidence };
    } catch (error) {
      await this.failDurableOperation(durableOperationId, error);
      return this.failureResult(evidenceBase, startedAt, error);
    }
  }

  private async prepareDurableOperation(input: {
    operationId: string;
    scope: McpOperationScope;
    operationKey: string;
    request: unknown;
  }): Promise<
    | { outcome: "new"; operationId: string }
    | { outcome: "replay"; result: McpOperationResult<unknown> }
    | { outcome: "blocked"; operation: DurableOperationRecord }
  > {
    if (!this.durableOperations) return { outcome: "new", operationId: input.operationKey };
    const prepared = await this.durableOperations.prepare({
      organizationId: input.scope.organizationId,
      kind: "mcp",
      operationKey: input.operationKey,
      requestFingerprint: fingerprintOperationRequest(input.request),
      metadata: { operation: "mcp", operationId: input.operationId },
    });
    if (prepared.outcome === "completed") {
      const receipt = prepared.operation.responseReceipt as { value?: unknown; evidence?: McpOperationEvidence } | undefined;
      if (receipt?.evidence && "value" in receipt) return { outcome: "replay", result: { ok: true, outcome: "success", value: receipt.value, evidence: receipt.evidence } };
      return { outcome: "blocked", operation: prepared.operation };
    }
    if (prepared.outcome === "unknown" || prepared.outcome === "in_progress") return { outcome: "blocked", operation: prepared.operation };
    await this.durableOperations.markRunning({ operationId: prepared.operation.id });
    return { outcome: "new", operationId: prepared.operation.id };
  }

  private async completeDurableOperation(operationId: string, receipt: { value: unknown; evidence: McpOperationEvidence }): Promise<void> {
    if (!this.durableOperations) return;
    await this.durableOperations.complete({ operationId, responseReceipt: receipt });
  }

  private async failDurableOperation(operationId: string | undefined, error: unknown): Promise<void> {
    if (!this.durableOperations || !operationId) return;
    const failure = classifyFailure(error);
    try {
      if (failure.outcome === "unknown") {
        await this.durableOperations.markUnknown({ operationId, error: { code: failure.code, message: failure.message } });
      } else {
        await this.durableOperations.fail({ operationId, error: { code: failure.code, message: failure.message, retryable: failure.outcome === "retryable" } });
      }
    } catch {
      // A provider result must never be replaced with a persistence exception.
    }
  }

  private durableBlockedResult<T>(
    evidenceBase: Omit<McpOperationEvidence, "outcome" | "durationMs">,
    startedAt: number,
    operation: DurableOperationRecord,
  ): McpOperationResult<T> {
    const code = operation.status === "unknown" ? "MCP_OPERATION_OUTCOME_UNKNOWN" : "MCP_OPERATION_IN_PROGRESS";
    const evidence = this.finishEvidence({ ...evidenceBase, outcome: "unknown", errorCode: code, durationMs: elapsedMs(startedAt) });
    return { ok: false, outcome: "unknown", error: { code, outcome: "unknown", message: operation.status === "unknown" ? "The MCP operation needs reconciliation." : "The MCP operation is already being processed." }, evidence };
  }

  private async runWithCancellation<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) throw new McpBoundaryFault("MCP_OPERATION_CANCELLED", "terminal");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let cancellation: "timeout" | "cancel" | undefined;

    return new Promise<T>((resolve, reject) => {
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
        callback();
      };
      const onCallerAbort = (): void => {
        cancellation = "cancel";
        controller.abort(callerSignal?.reason);
        finish(() => reject(new McpBoundaryFault("MCP_OPERATION_CANCELLED", "terminal")));
      };
      callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
      timer = setTimeout(() => {
        cancellation = "timeout";
        controller.abort(new Error("MCP_OPERATION_TIMEOUT"));
        finish(() => reject(new McpBoundaryFault("MCP_OPERATION_TIMEOUT", "retryable")));
      }, timeoutMs);
      Promise.resolve()
        .then(() => operation(controller.signal))
        .then((value) => finish(() => resolve(value)))
        .catch((error: unknown) => finish(() => reject(cancellation === "timeout"
          ? new McpBoundaryFault("MCP_OPERATION_TIMEOUT", "retryable")
          : cancellation === "cancel"
            ? new McpBoundaryFault("MCP_OPERATION_CANCELLED", "terminal")
            : error)));
    });
  }

  private finishEvidence(evidence: McpOperationEvidence): McpOperationEvidence {
    const frozen = deepFreeze(evidence);
    try {
      const result = this.onEvidence?.(frozen);
      if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch(() => undefined);
    } catch {
      // Evidence delivery must not change the remote operation outcome.
    }
    return frozen;
  }

  private failureResult<T extends object>(
    evidenceBase: Omit<McpOperationEvidence, "outcome" | "durationMs">,
    startedAt: number,
    error: unknown,
  ): McpOperationResult<T> {
    const failure = classifyFailure(error);
    const evidence = this.finishEvidence({
      ...evidenceBase,
      outcome: failure.outcome,
      errorCode: failure.code,
      durationMs: elapsedMs(startedAt),
    });
    return { ok: false, outcome: failure.outcome, error: failure, evidence };
  }
}

const toolNameSchema = identifierSchema.regex(/^[A-Za-z0-9._:-]+$/);
const discoveryInputSchema = z.object({
  scope: scopeSchema,
  serverId: identifierSchema,
  revision: z.number().int().positive(),
  endpointUrl: z.string().trim().url().max(2_000),
  authorizationToken: z.string().optional(),
  limits: operationLimitsSchema,
  environment: z.enum(["development", "test", "production"]),
  operationId: identifierSchema.optional(),
  signal: z.custom<AbortSignal>().optional(),
}).strict();

export function createMcpServerSnapshot(input: McpServerSnapshotBody): McpServerSnapshot {
  const { checksum: _ignoredChecksum, ...body } = input as McpServerSnapshotBody & { checksum?: string };
  const parsed = snapshotBodySchema.parse({
    ...body,
    endpointUrl: validateRemoteMcpEndpoint(body.endpointUrl, "test").toString(),
  });
  const checksum = snapshotChecksum(parsed);
  return deepFreeze({ ...parsed, checksum });
}

export function publishMcpServerSnapshot(snapshot: McpServerSnapshot): McpServerSnapshot {
  const validated = validateMcpServerSnapshot(snapshot, snapshot.scope, "test", false);
  return createMcpServerSnapshot({ ...validated, state: "published" });
}

export function validateMcpServerSnapshot(
  snapshot: McpServerSnapshot,
  expectedScope: McpOperationScope,
  environment: "development" | "test" | "production" = "production",
  requirePublished = true,
): McpServerSnapshot {
  let parsedScope: McpOperationScope;
  let parsed: McpServerSnapshot;
  try {
    parsedScope = scopeSchema.parse(expectedScope);
  } catch {
    throw new McpBoundaryFault("MCP_OPERATION_SCOPE_INVALID", "terminal");
  }
  try {
    parsed = mcpServerSnapshotSchema.parse(snapshot);
  } catch {
    throw new McpBoundaryFault("MCP_SNAPSHOT_INVALID", "terminal");
  }
  if (parsed.scope.organizationId !== parsedScope.organizationId || parsed.scope.agentVersionId !== parsedScope.agentVersionId) {
    throw new McpBoundaryFault("MCP_SNAPSHOT_SCOPE_MISMATCH", "terminal");
  }
  if (requirePublished && parsed.state !== "published") {
    throw new McpBoundaryFault("MCP_SNAPSHOT_NOT_PUBLISHED", "terminal");
  }
  validateRemoteMcpEndpoint(parsed.endpointUrl, environment);
  if (snapshotChecksum(parsed) !== parsed.checksum) {
    throw new McpBoundaryFault("MCP_SNAPSHOT_CHECKSUM_MISMATCH", "terminal");
  }
  boundToolSchemas(parsed.tools, parsed.limits);
  return deepFreeze(parsed);
}

function resolveLimits(overrides: Partial<McpOperationLimits> | undefined): McpOperationLimits {
  return operationLimitsSchema.parse({ ...DEFAULT_MCP_OPERATION_LIMITS, ...(overrides ?? {}) });
}

function safeLimits(overrides: Partial<McpOperationLimits> | undefined, defaults: McpOperationLimits): McpOperationLimits {
  try {
    return resolveLimits({ ...defaults, ...(overrides ?? {}) });
  } catch {
    throw new McpBoundaryFault("MCP_OPERATION_LIMITS_INVALID", "terminal");
  }
}

function parseScope(scope: McpOperationScope): McpOperationScope {
  try {
    return scopeSchema.parse(scope);
  } catch {
    throw new McpBoundaryFault("MCP_OPERATION_SCOPE_INVALID", "terminal");
  }
}

function scopeForEvidence(scope: unknown): McpOperationScope {
  const parsed = scopeSchema.safeParse(scope);
  return parsed.success ? parsed.data : { organizationId: "invalid-scope", agentVersionId: "invalid-scope" };
}

function validateProtocolVersion(value: string): string {
  if (!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(value as typeof MCP_SUPPORTED_PROTOCOL_VERSIONS[number])) {
    throw new McpBoundaryFault("MCP_PROTOCOL_UNSUPPORTED", "terminal");
  }
  return value;
}

function boundToolSchemas(tools: RemoteMcpTool[], limits: McpOperationLimits): RemoteMcpTool[] {
  let parsed: RemoteMcpTool[];
  try {
    parsed = remoteMcpToolsSchema.parse(tools);
  } catch {
    throw new McpBoundaryFault("MCP_TOOL_SCHEMA_INVALID", "terminal");
  }
  if (parsed.length > limits.maxTools) throw new McpBoundaryFault("MCP_TOOL_SCHEMA_COUNT_EXCEEDED", "terminal");
  if (toolSchemaBytes(parsed) > limits.maxSchemaBytes) throw new McpBoundaryFault("MCP_TOOL_SCHEMA_BYTES_EXCEEDED", "terminal");
  return deepFreeze(parsed.map((tool) => ({ ...tool, inputSchema: deepFreeze({ ...tool.inputSchema }) })));
}

function toolSchemaBytes(tools: readonly RemoteMcpTool[]): number {
  return byteLength(stableJson(tools));
}

function boundToolResult(value: unknown, maxBytes: number): McpCallValue {
  const redacted = redactSensitiveValue(value);
  const originalBytes = byteLength(stableJson(redacted));
  if (originalBytes <= maxBytes) return { result: redacted, resultBytes: originalBytes, resultTruncated: false };
  const marker = { _kasitek: { truncated: true, originalBytes } };
  const bounded = truncateValue(redacted, maxBytes, marker);
  const resultBytes = byteLength(stableJson(bounded));
  return { result: bounded, resultBytes, resultTruncated: true };
}

function truncateValue(value: unknown, maxBytes: number, marker: Record<string, unknown>): unknown {
  if (byteLength(stableJson(marker)) >= maxBytes) return "[TRUNCATED]";
  if (typeof value === "string") {
    const suffix = "…[TRUNCATED]";
    const budget = Math.max(0, maxBytes - byteLength(JSON.stringify(suffix)) - 2);
    let candidate = value;
    while (candidate.length && byteLength(JSON.stringify(`${candidate}${suffix}`)) > budget) candidate = candidate.slice(0, Math.ceil(candidate.length / 2));
    return `${candidate}${suffix}`;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      const candidate = [...result, entry, marker];
      if (byteLength(stableJson(candidate)) > maxBytes) break;
      result.push(entry);
    }
    return [...result, marker];
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const candidate = { ...result, [key]: (value as Record<string, unknown>)[key], _kasitek: marker._kasitek };
      if (byteLength(stableJson(candidate)) > maxBytes) break;
      result[key] = (value as Record<string, unknown>)[key];
    }
    return { ...result, _kasitek: marker._kasitek };
  }
  return marker;
}

function classifyFailure(error: unknown): McpOperationFailure {
  if (error instanceof McpBoundaryFault) return { code: error.code, outcome: error.outcome, message: stableFailureMessage(error.code) };
  if (error instanceof z.ZodError) return { code: "MCP_INPUT_INVALID", outcome: "terminal", message: stableFailureMessage("MCP_INPUT_INVALID") };
  const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : undefined;
  const rawCode = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined;
  const rawMessage = error instanceof Error ? error.message : "";
  const remoteCode = /^REMOTE_MCP_[A-Z0-9_]+/.exec(rawMessage)?.[0] ?? rawCode;
  if (statusCode !== undefined) {
    const code = `MCP_REMOTE_HTTP_${statusCode}`;
    return { code, outcome: statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500 ? "retryable" : "terminal", message: stableFailureMessage(code) };
  }
  if (remoteCode === "REMOTE_MCP_RATE_LIMITED" || remoteCode === "REMOTE_MCP_HTTP_408" || remoteCode === "REMOTE_MCP_HTTP_425" || remoteCode === "REMOTE_MCP_HTTP_429" || /^REMOTE_MCP_HTTP_5\d\d$/.test(remoteCode ?? "")) {
    return { code: remoteCode!, outcome: "retryable", message: stableFailureMessage(remoteCode!) };
  }
  if (remoteCode && /^REMOTE_MCP_(ENDPOINT_|TOOL_SCHEMA_|RESPONSE_|TOOL_FAILED|TOOL_NOT_|PROVIDER_|RPC_ERROR|PROTOCOL_)/.test(remoteCode)) {
    return { code: remoteCode, outcome: "terminal", message: stableFailureMessage(remoteCode) };
  }
  return { code: "MCP_REMOTE_UNKNOWN_FAILURE", outcome: "unknown", message: stableFailureMessage("MCP_REMOTE_UNKNOWN_FAILURE") };
}

function stableFailureMessage(code: string): string {
  if (code === "MCP_OPERATION_TIMEOUT") return "The MCP operation timed out.";
  if (code === "MCP_OPERATION_CANCELLED") return "The MCP operation was cancelled.";
  if (code.includes("HTTP_429") || code === "REMOTE_MCP_RATE_LIMITED") return "The MCP server is rate limited.";
  if (code.includes("HTTP_5") || code.includes("HTTP_408") || code.includes("HTTP_425")) return "The MCP server is temporarily unavailable.";
  if (code.includes("UNKNOWN")) return "The MCP server returned an unknown failure.";
  return "The MCP operation was rejected.";
}

function snapshotChecksum(snapshot: McpServerSnapshotBody): string {
  return createHash("sha256").update(stableJson({
    schemaVersion: "mcp.snapshot.v1",
    scope: snapshot.scope,
    serverId: snapshot.serverId,
    revision: snapshot.revision,
    endpointUrl: snapshot.endpointUrl,
    protocolVersion: snapshot.protocolVersion,
    state: snapshot.state,
    tools: snapshot.tools,
    limits: snapshot.limits,
  }), "utf8").digest("hex");
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(stableJson(redactSensitiveValue(value)), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value)) ?? "null";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableValue(entry)]));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function operationIdFrom(value: string | undefined): string {
  return value?.trim() ? value.trim().slice(0, 160) : randomUUID();
}

function safeIdentifier(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 160) : fallback;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
