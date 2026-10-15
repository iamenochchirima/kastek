import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  assessExtensionPackageReadiness,
  validateExtensionPackageManifest,
  type ExtensionPackageManifest,
  type ExtensionPackageRuntime,
} from "./package-manifest";
import { ToolRegistry } from "../tools/registry";
import type { ToolDefinition, ToolInvocationContext } from "../tools/types";

export const PLUGIN_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_PLUGIN_EXECUTION_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 256 * 1024,
  maxFrameBytes: 384 * 1024,
  timeoutMs: 30_000,
  cleanupTimeoutMs: 1_000,
});

export interface PluginExecutionLimits {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxFrameBytes: number;
  timeoutMs: number;
  cleanupTimeoutMs: number;
}

export interface PluginExecutionPackage {
  organizationId: string;
  packageVersionId: string;
  manifest: Readonly<ExtensionPackageManifest>;
}

export interface PluginExecutionScope {
  organizationId: string;
  capabilityGrants: readonly string[];
}

export interface PluginExecutionRequest<TInput = unknown> {
  operationId?: string;
  package: PluginExecutionPackage;
  runtime: ExtensionPackageRuntime;
  scope: PluginExecutionScope;
  input: TInput;
  signal?: AbortSignal;
  limits?: Partial<PluginExecutionLimits>;
}

export type PluginExecutionFailureCode =
  | "PLUGIN_PACKAGE_INVALID"
  | "PLUGIN_PACKAGE_NOT_READY"
  | "PLUGIN_DIGEST_MISMATCH"
  | "PLUGIN_RUNTIME_INCOMPATIBLE"
  | "PLUGIN_GRANT_MISMATCH"
  | "PLUGIN_SCOPE_MISMATCH"
  | "PLUGIN_INPUT_TOO_LARGE"
  | "PLUGIN_OUTPUT_TOO_LARGE"
  | "PLUGIN_PROTOCOL_INVALID"
  | "PLUGIN_TIMEOUT"
  | "PLUGIN_CANCELLED"
  | "PLUGIN_PROCESS_CRASHED"
  | "PLUGIN_PROCESS_ERROR"
  | "PLUGIN_CLEANUP_FAILED";

export interface PluginCleanupEvidence {
  terminationAttempted: boolean;
  terminated: boolean;
  disposalAttempted: boolean;
  disposed: boolean;
}

/** Evidence is intentionally metadata-only: it contains no input, output, prompts, configuration, or error text. */
export interface PluginExecutionEvidence {
  evidenceVersion: "plugin.execution.v1";
  operationId: string;
  packageId: string;
  packageVersion: string;
  packageChecksum: string;
  outcome: "succeeded" | "rejected" | "failed" | "timed_out" | "cancelled";
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  declaredCapabilityCount: number;
  grantedCapabilityCount: number;
  cleanup: PluginCleanupEvidence;
  failureCode?: PluginExecutionFailureCode;
}

export type PluginExecutionResult<TOutput = unknown> =
  | { ok: true; output: TOutput; evidence: PluginExecutionEvidence }
  | { ok: false; error: { code: PluginExecutionFailureCode; message: string }; evidence: PluginExecutionEvidence };

export interface PluginWorkerRequest {
  type: "kasitek.plugin.execute";
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  operationId: string;
  packageId: string;
  packageVersion: string;
  packageChecksum: string;
  entrypoint: string;
  capabilities: readonly string[];
  configuration: Readonly<Record<string, unknown>>;
  input: unknown;
}

export interface PluginWorkerSuccessResponse {
  type: "kasitek.plugin.result";
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  operationId: string;
  ok: true;
  output: unknown;
}

export interface PluginWorkerFailureResponse {
  type: "kasitek.plugin.result";
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  operationId: string;
  ok: false;
  error: { code: string; message?: string };
}

export type PluginWorkerResponse = PluginWorkerSuccessResponse | PluginWorkerFailureResponse;

export interface PluginSubprocessDescriptor {
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  packageId: string;
  packageVersion: string;
  packageChecksum: string;
  entrypoint: string;
  limits: Pick<PluginExecutionLimits, "maxOutputBytes" | "maxFrameBytes">;
}

export type PluginTerminationReason = "completed" | "timeout" | "cancelled" | "failure";

/** A single-use process boundary. The process must not share the Temporal worker module graph. */
export interface PluginSubprocess {
  execute(frame: string, signal: AbortSignal): Promise<string>;
  terminate(reason: PluginTerminationReason): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface PluginSubprocessFactory {
  create(descriptor: PluginSubprocessDescriptor): PluginSubprocess | Promise<PluginSubprocess>;
}

export interface PluginEvidenceSink {
  record(evidence: PluginExecutionEvidence): void | Promise<void>;
}

type JsonObject = Record<string, unknown>;

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/i;
const ENTRYPOINT_PATTERN = /^[A-Za-z0-9_@./:-]+$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonString(value: unknown, code: PluginProtocolFailureCode = "invalid_field"): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not-json");
    return serialized;
  } catch {
    throw new PluginProtocolError(code, "value is not JSON serializable");
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertExactKeys(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new PluginProtocolError("unknown_field", `unsupported protocol field ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new PluginProtocolError("missing_field", `missing protocol field ${key}`);
  }
}

function assertString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new PluginProtocolError("invalid_field", `invalid protocol field ${field}`);
  }
  return value;
}

function assertCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !CAPABILITY_PATTERN.test(entry))) {
    throw new PluginProtocolError("invalid_field", "invalid protocol capabilities");
  }
  return sortedUnique(value);
}

function assertConfiguration(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new PluginProtocolError("invalid_field", "configuration must be an object");
  return value;
}

function assertFrameSize(frame: string, limits: Pick<PluginExecutionLimits, "maxFrameBytes">): void {
  if (byteLength(frame) > limits.maxFrameBytes) throw new PluginProtocolError("frame_too_large", "protocol frame exceeds the configured limit");
}

function parseFrame(raw: string, limits: Pick<PluginExecutionLimits, "maxFrameBytes">): JsonObject {
  assertFrameSize(raw, limits);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PluginProtocolError("invalid_json", "protocol frame is not valid JSON");
  }
  if (!isRecord(parsed)) throw new PluginProtocolError("invalid_frame", "protocol frame must be an object");
  return parsed;
}

export type PluginProtocolFailureCode =
  | "unknown_field"
  | "missing_field"
  | "invalid_field"
  | "frame_too_large"
  | "invalid_json"
  | "invalid_frame"
  | "output_too_large";

export class PluginProtocolError extends Error {
  public readonly code: PluginProtocolFailureCode;

  public constructor(code: PluginProtocolFailureCode, message: string) {
    super(message);
    this.name = "PluginProtocolError";
    this.code = code;
  }
}

export class PluginSubprocessCrashedError extends Error {
  public constructor() {
    super("plugin subprocess crashed");
    this.name = "PluginSubprocessCrashedError";
  }
}

/** Encode exactly one request frame. No shell command or module import is involved. */
export function encodePluginWorkerRequest(
  request: PluginWorkerRequest,
  limits: Pick<PluginExecutionLimits, "maxFrameBytes"> = DEFAULT_PLUGIN_EXECUTION_LIMITS,
): string {
  const frame = jsonString(request, "invalid_field");
  assertFrameSize(frame, limits);
  return frame;
}

/** Parse and validate exactly one request frame at the process boundary. */
export function decodePluginWorkerRequest(
  raw: string,
  limits: Pick<PluginExecutionLimits, "maxFrameBytes"> = DEFAULT_PLUGIN_EXECUTION_LIMITS,
): PluginWorkerRequest {
  const value = parseFrame(raw, limits);
  assertExactKeys(value, ["type", "protocolVersion", "operationId", "packageId", "packageVersion", "packageChecksum", "entrypoint", "capabilities", "configuration", "input"]);
  if (value.type !== "kasitek.plugin.execute" || value.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
    throw new PluginProtocolError("invalid_field", "unsupported plugin request type or protocol version");
  }
  const packageChecksum = assertString(value.packageChecksum, "packageChecksum", 64).toLowerCase();
  if (!CHECKSUM_PATTERN.test(packageChecksum)) throw new PluginProtocolError("invalid_field", "invalid package checksum");
  const entrypoint = assertString(value.entrypoint, "entrypoint");
  if (!ENTRYPOINT_PATTERN.test(entrypoint) || entrypoint.includes("..") || entrypoint.startsWith("/")) {
    throw new PluginProtocolError("invalid_field", "invalid plugin entrypoint");
  }
  const input = value.input;
  jsonString(input);
  return Object.freeze({
    type: "kasitek.plugin.execute",
    protocolVersion: PLUGIN_PROTOCOL_VERSION,
    operationId: assertString(value.operationId, "operationId", 128),
    packageId: assertString(value.packageId, "packageId"),
    packageVersion: assertString(value.packageVersion, "packageVersion", 64),
    packageChecksum,
    entrypoint,
    capabilities: assertCapabilities(value.capabilities),
    configuration: assertConfiguration(value.configuration),
    input,
  });
}

/** Encode one response frame after enforcing the output byte budget. */
export function encodePluginWorkerResponse(
  response: PluginWorkerResponse,
  limits: Pick<PluginExecutionLimits, "maxOutputBytes" | "maxFrameBytes"> = DEFAULT_PLUGIN_EXECUTION_LIMITS,
): string {
  if (response.ok) {
    const output = jsonString(response.output);
    if (byteLength(output) > limits.maxOutputBytes) throw new PluginProtocolError("output_too_large", "plugin output exceeds the configured limit");
  }
  const frame = jsonString(response, "invalid_field");
  assertFrameSize(frame, limits);
  return frame;
}

/** Parse one response frame without exposing arbitrary plugin error text. */
export function decodePluginWorkerResponse(
  raw: string,
  limits: Pick<PluginExecutionLimits, "maxOutputBytes" | "maxFrameBytes"> = DEFAULT_PLUGIN_EXECUTION_LIMITS,
): PluginWorkerResponse {
  const value = parseFrame(raw, limits);
  assertExactKeys(value, ["type", "protocolVersion", "operationId", "ok"], ["output", "error"]);
  if (value.type !== "kasitek.plugin.result" || value.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
    throw new PluginProtocolError("invalid_field", "unsupported plugin response type or protocol version");
  }
  const operationId = assertString(value.operationId, "operationId", 128);
  if (typeof value.ok !== "boolean") throw new PluginProtocolError("invalid_field", "response ok must be boolean");
  if (value.ok) {
    if (!("output" in value) || "error" in value) throw new PluginProtocolError("invalid_field", "successful response must contain only output");
    const output = value.output;
    const serialized = jsonString(output);
    if (byteLength(serialized) > limits.maxOutputBytes) throw new PluginProtocolError("output_too_large", "plugin output exceeds the configured limit");
    return Object.freeze({ type: "kasitek.plugin.result", protocolVersion: PLUGIN_PROTOCOL_VERSION, operationId, ok: true, output });
  }
  if (!("error" in value) || "output" in value || !isRecord(value.error)) throw new PluginProtocolError("invalid_field", "failed response must contain an error");
  const code = assertString(value.error.code, "error.code", 128);
  if (value.error.message !== undefined && typeof value.error.message !== "string") throw new PluginProtocolError("invalid_field", "error.message must be a string");
  return Object.freeze({ type: "kasitek.plugin.result", protocolVersion: PLUGIN_PROTOCOL_VERSION, operationId, ok: false, error: { code } });
}

function normalizeLimits(limits: Partial<PluginExecutionLimits> | undefined): PluginExecutionLimits {
  const result = { ...DEFAULT_PLUGIN_EXECUTION_LIMITS, ...(limits ?? {}) };
  for (const key of ["maxInputBytes", "maxOutputBytes", "maxFrameBytes", "timeoutMs", "cleanupTimeoutMs"] as const) {
    if (!Number.isInteger(result[key]) || result[key] <= 0) throw new Error(`PLUGIN_LIMIT_INVALID:${key}`);
  }
  if (result.maxFrameBytes < result.maxOutputBytes || result.maxFrameBytes < result.maxInputBytes) throw new Error("PLUGIN_LIMIT_INVALID:maxFrameBytes");
  return result;
}

function failureMessage(code: PluginExecutionFailureCode): string {
  const messages: Record<PluginExecutionFailureCode, string> = {
    PLUGIN_PACKAGE_INVALID: "The plugin package is invalid.",
    PLUGIN_PACKAGE_NOT_READY: "The plugin package is not ready to execute.",
    PLUGIN_DIGEST_MISMATCH: "The plugin package digest is not trusted.",
    PLUGIN_RUNTIME_INCOMPATIBLE: "The plugin package is incompatible with this runtime.",
    PLUGIN_GRANT_MISMATCH: "The plugin does not have the required capability grants.",
    PLUGIN_SCOPE_MISMATCH: "The plugin package is outside the execution scope.",
    PLUGIN_INPUT_TOO_LARGE: "Plugin input exceeds the configured limit.",
    PLUGIN_OUTPUT_TOO_LARGE: "Plugin output exceeds the configured limit.",
    PLUGIN_PROTOCOL_INVALID: "The plugin returned an invalid protocol response.",
    PLUGIN_TIMEOUT: "The plugin execution timed out.",
    PLUGIN_CANCELLED: "The plugin execution was cancelled.",
    PLUGIN_PROCESS_CRASHED: "The plugin process exited unexpectedly.",
    PLUGIN_PROCESS_ERROR: "The plugin process could not complete the execution.",
    PLUGIN_CLEANUP_FAILED: "The plugin process could not be cleaned up.",
  };
  return messages[code];
}

function readinessFailureCode(
  failures: readonly { code: string }[],
): PluginExecutionFailureCode {
  if (failures.some((failure) => failure.code === "checksum_untrusted")) return "PLUGIN_DIGEST_MISMATCH";
  if (failures.some((failure) => failure.code.startsWith("runtime_") || failure.code === "execution_mode_unsupported")) return "PLUGIN_RUNTIME_INCOMPATIBLE";
  if (failures.some((failure) => failure.code === "permission_not_granted")) return "PLUGIN_GRANT_MISMATCH";
  return "PLUGIN_PACKAGE_NOT_READY";
}

function makeEvidence(input: {
  operationId: string;
  package: PluginExecutionPackage;
  outcome: PluginExecutionEvidence["outcome"];
  startedAt: number;
  inputBytes: number;
  outputBytes: number;
  declaredCapabilityCount: number;
  grantedCapabilityCount: number;
  cleanup: PluginCleanupEvidence;
  failureCode?: PluginExecutionFailureCode;
}): PluginExecutionEvidence {
  return {
    evidenceVersion: "plugin.execution.v1",
    operationId: input.operationId,
    packageId: input.package.manifest.id,
    packageVersion: input.package.manifest.version,
    packageChecksum: input.package.manifest.checksum,
    outcome: input.outcome,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    inputBytes: input.inputBytes,
    outputBytes: input.outputBytes,
    declaredCapabilityCount: input.declaredCapabilityCount,
    grantedCapabilityCount: input.grantedCapabilityCount,
    cleanup: input.cleanup,
    ...(input.failureCode ? { failureCode: input.failureCode } : {}),
  };
}

function failedAdmission(input: {
  code: PluginExecutionFailureCode;
  operationId: string;
  package: PluginExecutionPackage;
  startedAt: number;
  limits: PluginExecutionLimits;
  inputBytes: number;
  declaredCapabilityCount: number;
  grantedCapabilityCount: number;
}): PluginExecutionResult {
  const cleanup = { terminationAttempted: false, terminated: false, disposalAttempted: false, disposed: false };
  const evidence = makeEvidence({ ...input, outcome: "rejected", outputBytes: 0, cleanup });
  return { ok: false, error: { code: input.code, message: failureMessage(input.code) }, evidence };
}

function boundedJsonBytes(value: unknown): number {
  return byteLength(jsonString(value));
}

interface Admission {
  requestFrame: string;
  descriptor: PluginSubprocessDescriptor;
  capabilities: readonly string[];
  inputBytes: number;
  limits: PluginExecutionLimits;
}

function admit<TInput>(request: PluginExecutionRequest<TInput>, operationId: string, limits: PluginExecutionLimits): Admission | PluginExecutionResult {
  const packageRef = request.package;
  const manifest = packageRef.manifest;
  const inputBytes = boundedJsonBytes(request.input);
  const declaredCapabilities = manifest.permissions;
  const grantedCapabilities = request.scope.capabilityGrants;
  const base = {
    operationId,
    package: packageRef,
    startedAt: Date.now(),
    limits,
    inputBytes,
    declaredCapabilityCount: declaredCapabilities.length,
    grantedCapabilityCount: grantedCapabilities.length,
  };

  if (!packageRef.organizationId.trim() || !packageRef.packageVersionId.trim()) return failedAdmission({ ...base, code: "PLUGIN_PACKAGE_INVALID" });
  if (packageRef.organizationId !== request.scope.organizationId) return failedAdmission({ ...base, code: "PLUGIN_SCOPE_MISMATCH" });
  const validation = validateExtensionPackageManifest(manifest);
  if (!validation.ok) return failedAdmission({ ...base, code: "PLUGIN_PACKAGE_INVALID" });
  if (validation.manifest.kind !== "plugin" || validation.manifest.execution.mode !== "plugin") return failedAdmission({ ...base, code: "PLUGIN_PACKAGE_INVALID" });

  const readiness = assessExtensionPackageReadiness(validation.manifest, request.runtime);
  if (!readiness.ready) return failedAdmission({ ...base, code: readinessFailureCode(readiness.failures) });

  const requiredGrants = new Set(declaredCapabilities);
  const scopeGrants = new Set(request.scope.capabilityGrants);
  if ([...requiredGrants].some((permission) => !scopeGrants.has(permission))) return failedAdmission({ ...base, code: "PLUGIN_GRANT_MISMATCH" });

  const input = request.input;
  if (inputBytes > limits.maxInputBytes) return failedAdmission({ ...base, code: "PLUGIN_INPUT_TOO_LARGE" });
  const capabilities = sortedUnique(declaredCapabilities);
  const workerRequest: PluginWorkerRequest = {
    type: "kasitek.plugin.execute",
    protocolVersion: PLUGIN_PROTOCOL_VERSION,
    operationId,
    packageId: validation.manifest.id,
    packageVersion: validation.manifest.version,
    packageChecksum: validation.manifest.checksum,
    entrypoint: validation.manifest.execution.entrypoint,
    capabilities,
    configuration: readiness.configuration,
    input,
  };
  let requestFrame: string;
  try {
    requestFrame = encodePluginWorkerRequest(workerRequest, limits);
  } catch (error) {
    if (error instanceof PluginProtocolError && error.code === "frame_too_large") return failedAdmission({ ...base, code: "PLUGIN_INPUT_TOO_LARGE" });
    return failedAdmission({ ...base, code: "PLUGIN_PROTOCOL_INVALID" });
  }
  return { requestFrame, descriptor: { protocolVersion: PLUGIN_PROTOCOL_VERSION, packageId: validation.manifest.id, packageVersion: validation.manifest.version, packageChecksum: validation.manifest.checksum, entrypoint: validation.manifest.execution.entrypoint, limits }, capabilities, inputBytes, limits };
}

async function within<T>(work: () => Promise<T> | T, timeoutMs: number): Promise<{ completed: boolean; value?: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(work).then((value) => ({ completed: true as const, value })),
      new Promise<{ completed: false }>((resolve) => { timer = setTimeout(() => resolve({ completed: false }), timeoutMs); }),
    ]);
    return result;
  } catch {
    return { completed: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function recordEvidence(sink: PluginEvidenceSink | undefined, evidence: PluginExecutionEvidence): Promise<void> {
  if (!sink) return;
  try {
    await sink.record(evidence);
  } catch {
    // Evidence sinks are observational and must never change plugin outcomes.
  }
}

export interface IsolatedPluginAdapterOptions {
  factory: PluginSubprocessFactory;
  defaultLimits?: Partial<PluginExecutionLimits>;
  evidenceSink?: PluginEvidenceSink;
}

/**
 * Executes a plugin through a single-use subprocess protocol. This class owns
 * admission, bounded framing, cancellation, and cleanup; it never imports or
 * evaluates a plugin entrypoint in the Temporal worker process.
 */
export class IsolatedPluginAdapter {
  private readonly factory: PluginSubprocessFactory;
  private readonly defaultLimits: Partial<PluginExecutionLimits>;
  private readonly evidenceSink?: PluginEvidenceSink;

  public constructor(options: IsolatedPluginAdapterOptions) {
    this.factory = options.factory;
    this.defaultLimits = options.defaultLimits ?? {};
    this.evidenceSink = options.evidenceSink;
  }

  public async execute<TInput, TOutput = unknown>(request: PluginExecutionRequest<TInput>): Promise<PluginExecutionResult<TOutput>> {
    const startedAt = Date.now();
    const operationId = request.operationId?.trim() || randomUUID();
    let limits: PluginExecutionLimits;
    try {
      limits = normalizeLimits({ ...this.defaultLimits, ...(request.limits ?? {}) });
    } catch {
      const invalidLimits = { ...DEFAULT_PLUGIN_EXECUTION_LIMITS };
      const result = failedAdmission({ operationId, package: request.package, startedAt, limits: invalidLimits, inputBytes: 0, declaredCapabilityCount: request.package.manifest.permissions.length, grantedCapabilityCount: request.scope.capabilityGrants.length, code: "PLUGIN_PACKAGE_INVALID" }) as PluginExecutionResult<TOutput>;
      await recordEvidence(this.evidenceSink, result.evidence);
      return result;
    }

    let inputBytes = 0;
    try {
      inputBytes = boundedJsonBytes(request.input);
    } catch {
      const result = failedAdmission({ operationId, package: request.package, startedAt, limits, inputBytes: 0, declaredCapabilityCount: request.package.manifest.permissions.length, grantedCapabilityCount: request.scope.capabilityGrants.length, code: "PLUGIN_INPUT_TOO_LARGE" }) as PluginExecutionResult<TOutput>;
      await recordEvidence(this.evidenceSink, result.evidence);
      return result;
    }
    const admission = admit(request, operationId, limits);
    if (!("requestFrame" in admission)) {
      await recordEvidence(this.evidenceSink, admission.evidence);
      return admission as PluginExecutionResult<TOutput>;
    }

    let subprocess: PluginSubprocess | undefined;
    let output: TOutput | undefined;
    let outputBytes = 0;
    let failureCode: PluginExecutionFailureCode | undefined;
    let outcome: PluginExecutionEvidence["outcome"] = "failed";
    let terminationReason: PluginTerminationReason = "failure";
    let cleanup: PluginCleanupEvidence = { terminationAttempted: false, terminated: false, disposalAttempted: false, disposed: false };

    try {
      if (request.signal?.aborted) {
        failureCode = "PLUGIN_CANCELLED";
        outcome = "cancelled";
      } else {
        subprocess = await this.factory.create(admission.descriptor);
        const controller = new AbortController();
        let abortReason: "timeout" | "cancelled" | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onExternalAbort = () => {
          if (!abortReason) abortReason = "cancelled";
          controller.abort();
        };
        const abortPromise = new Promise<{ kind: "aborted"; reason: "timeout" | "cancelled" }>((resolve) => {
          controller.signal.addEventListener("abort", () => resolve({ kind: "aborted", reason: abortReason ?? "cancelled" }), { once: true });
        });
        if (request.signal?.aborted) onExternalAbort();
        else request.signal?.addEventListener("abort", onExternalAbort, { once: true });
        timer = setTimeout(() => {
          abortReason = "timeout";
          controller.abort();
        }, admission.limits.timeoutMs);
        try {
          const processResult = await Promise.race([
            subprocess.execute(admission.requestFrame, controller.signal).then((frame) => ({ kind: "response" as const, frame })),
            abortPromise,
          ]);
          if (processResult.kind === "aborted") {
            failureCode = processResult.reason === "timeout" ? "PLUGIN_TIMEOUT" : "PLUGIN_CANCELLED";
            outcome = processResult.reason === "timeout" ? "timed_out" : "cancelled";
            terminationReason = processResult.reason;
          } else {
            const response = decodePluginWorkerResponse(processResult.frame, admission.limits);
            if (response.operationId !== operationId) throw new PluginProtocolError("invalid_field", "response operation id does not match request");
            if (!response.ok) {
              failureCode = "PLUGIN_PROCESS_ERROR";
              outcome = "failed";
            } else {
              output = response.output as TOutput;
              outputBytes = boundedJsonBytes(output);
              outcome = "succeeded";
              terminationReason = "completed";
            }
          }
        } catch (error) {
          if (abortReason === "timeout") {
            failureCode = "PLUGIN_TIMEOUT";
            outcome = "timed_out";
            terminationReason = "timeout";
          } else if (abortReason === "cancelled" || request.signal?.aborted) {
            failureCode = "PLUGIN_CANCELLED";
            outcome = "cancelled";
            terminationReason = "cancelled";
          } else if (error instanceof PluginProtocolError) {
            failureCode = error.code === "output_too_large" || error.code === "frame_too_large" ? "PLUGIN_OUTPUT_TOO_LARGE" : "PLUGIN_PROTOCOL_INVALID";
          } else if (error instanceof PluginSubprocessCrashedError) {
            failureCode = "PLUGIN_PROCESS_CRASHED";
          } else {
            failureCode = "PLUGIN_PROCESS_ERROR";
          }
          outcome = "failed";
        } finally {
          if (timer) clearTimeout(timer);
          request.signal?.removeEventListener("abort", onExternalAbort);
        }
      }
    } catch (error) {
      failureCode = error instanceof PluginSubprocessCrashedError ? "PLUGIN_PROCESS_CRASHED" : "PLUGIN_PROCESS_ERROR";
      outcome = "failed";
    }

    if (subprocess) {
      cleanup.terminationAttempted = true;
      const terminated = await within(() => subprocess!.terminate(terminationReason), admission.limits.cleanupTimeoutMs);
      cleanup.terminated = terminated.completed;
      cleanup.disposalAttempted = true;
      const disposed = await within(() => subprocess!.dispose(), admission.limits.cleanupTimeoutMs);
      cleanup.disposed = disposed.completed;
      if (!cleanup.terminated || !cleanup.disposed) {
        if (!failureCode) {
          failureCode = "PLUGIN_CLEANUP_FAILED";
          outcome = "failed";
        }
      }
    }

    const evidence = makeEvidence({ operationId, package: request.package, outcome, startedAt, inputBytes, outputBytes, declaredCapabilityCount: admission.capabilities.length, grantedCapabilityCount: request.scope.capabilityGrants.length, cleanup, ...(failureCode ? { failureCode } : {}) });
    await recordEvidence(this.evidenceSink, evidence);
    if (failureCode || outcome !== "succeeded") return { ok: false, error: { code: failureCode ?? "PLUGIN_PROCESS_ERROR", message: failureMessage(failureCode ?? "PLUGIN_PROCESS_ERROR") }, evidence } as PluginExecutionResult<TOutput>;
    return { ok: true, output: output as TOutput, evidence };
  }
}

export interface NodePluginSubprocessFactoryOptions {
  runnerPath: string;
  nodePath?: string;
  runnerArguments?: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Production transport for a trusted runner executable. The runner is a
 * separate process and receives the package descriptor as an argument, then
 * reads one JSON request line from stdin. Environment inheritance is opt-in so
 * worker credentials do not leak into plugin processes by default.
 */
export class NodePluginSubprocessFactory implements PluginSubprocessFactory {
  private readonly options: NodePluginSubprocessFactoryOptions;

  public constructor(options: NodePluginSubprocessFactoryOptions) {
    this.options = options;
  }

  public create(descriptor: PluginSubprocessDescriptor): PluginSubprocess {
    const metadata = JSON.stringify({
      protocolVersion: descriptor.protocolVersion,
      packageId: descriptor.packageId,
      packageVersion: descriptor.packageVersion,
      packageChecksum: descriptor.packageChecksum,
      entrypoint: descriptor.entrypoint,
    });
    const child = spawn(this.options.nodePath ?? process.execPath, [
      ...(this.options.runnerArguments ?? []),
      this.options.runnerPath,
      metadata,
    ], {
      cwd: this.options.cwd,
      env: this.options.environment ?? { NODE_ENV: "production" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new NodePluginSubprocess(child, descriptor.limits.maxFrameBytes);
  }
}

class NodePluginSubprocess implements PluginSubprocess {
  private buffer = "";
  private pending?: { resolve: (value: string) => void; reject: (error: Error) => void };
  private terminated = false;

  public constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly maxFrameBytes: number) {
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", () => undefined);
    child.on("error", () => this.failPending(new PluginSubprocessCrashedError()));
    child.on("exit", () => this.failPending(new PluginSubprocessCrashedError()));
  }

  public execute(frame: string, signal: AbortSignal): Promise<string> {
    if (this.terminated || this.child.stdin.destroyed) return Promise.reject(new PluginSubprocessCrashedError());
    if (signal.aborted) return Promise.reject(new Error("plugin execution aborted"));
    if (this.pending) return Promise.reject(new Error("plugin subprocess only supports one in-flight request"));
    return new Promise<string>((resolve, reject) => {
      this.pending = { resolve, reject };
      const abort = () => {
        signal.removeEventListener("abort", abort);
        this.failPending(new Error("plugin execution aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      this.child.stdin.once("error", () => this.failPending(new PluginSubprocessCrashedError()));
      this.child.stdin.write(`${frame}\n`, "utf8", (error) => {
        if (error) this.failPending(new PluginSubprocessCrashedError());
      });
    });
  }

  public terminate(): void {
    this.terminated = true;
    if (!this.child.killed) this.child.kill("SIGKILL");
  }

  public dispose(): void {
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.stdin.destroy();
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (byteLength(this.buffer) > this.maxFrameBytes) {
      this.failPending(new PluginProtocolError("frame_too_large", "plugin response frame exceeds the configured limit"));
      return;
    }
    const newline = this.buffer.indexOf("\n");
    if (newline < 0 || !this.pending) return;
    const frame = this.buffer.slice(0, newline).replace(/\r$/, "");
    this.buffer = this.buffer.slice(newline + 1);
    const pending = this.pending;
    this.pending = undefined;
    pending.resolve(frame);
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
}

export interface DeterministicPluginSubprocessOptions {
  execute: (request: PluginWorkerRequest, signal: AbortSignal) => PluginWorkerResponse | Promise<PluginWorkerResponse>;
  crash?: boolean;
}

/** Deterministic fake transport for tests and for capability-registry integration before live wiring. */
export class DeterministicPluginSubprocess implements PluginSubprocess {
  public terminated = false;
  public disposed = false;

  public constructor(private readonly options: DeterministicPluginSubprocessOptions) {}

  public async execute(frame: string, signal: AbortSignal): Promise<string> {
    if (this.options.crash) throw new PluginSubprocessCrashedError();
    const request = decodePluginWorkerRequest(frame);
    const response = await this.options.execute(request, signal);
    return encodePluginWorkerResponse(response);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public dispose(): void {
    this.disposed = true;
  }
}

export class DeterministicPluginSubprocessFactory implements PluginSubprocessFactory {
  public readonly processes: DeterministicPluginSubprocess[] = [];

  public constructor(private readonly options: DeterministicPluginSubprocessOptions) {}

  public create(): PluginSubprocess {
    const process = new DeterministicPluginSubprocess(this.options);
    this.processes.push(process);
    return process;
  }
}

/**
 * Compose an isolated plugin as an ordinary harness capability. The registry
 * still owns schema validation, approval, lifecycle, redaction, and grants;
 * this adapter owns only the process boundary.
 */
export type PluginToolDefinitionInput = {
  name: string;
  description: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  package: PluginExecutionPackage;
  runtime: ExtensionPackageRuntime;
  adapter: IsolatedPluginAdapter;
  riskClass?: ToolDefinition["riskClass"];
  requiresApproval?: boolean;
};

export function createPluginToolDefinition(input: PluginToolDefinitionInput): ToolDefinition {
  return {
    name: input.name,
    description: input.description,
    version: input.version,
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    riskClass: input.riskClass ?? "controlled-write",
    requiresApproval: input.requiresApproval ?? true,
    timeoutMs: DEFAULT_PLUGIN_EXECUTION_LIMITS.timeoutMs,
    manifest: {
      ownerService: "plugin-runtime",
      requiredScope: `plugin:${input.package.manifest.id}`,
      execution: "durable",
      idempotency: "required",
      approval: input.requiresApproval === false ? "policy" : "always",
      auditClassification: "restricted",
      redaction: ["output", "configuration"],
    },
    handler: async (context: ToolInvocationContext, argumentsValue: Record<string, unknown>) => {
      const result = await input.adapter.execute({
        operationId: context.operationId,
        package: input.package,
        runtime: input.runtime,
        scope: {
          organizationId: context.organizationId,
          capabilityGrants: context.scope.capabilityGrants ?? [],
        },
        input: argumentsValue,
        signal: context.signal,
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.output;
    },
  };
}

/** Registers only explicitly supplied isolated tools; no catalog metadata can create a tool. */
export function registerIsolatedPluginTools(registry: ToolRegistry, registrations: readonly PluginToolDefinitionInput[]): void {
  for (const registration of registrations) registry.register(createPluginToolDefinition(registration));
}
