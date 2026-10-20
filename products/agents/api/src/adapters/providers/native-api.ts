import type { RequestArguments, RequestTemplate, ResolvedOpenApiCredential } from "./openapi";
import { compileOpenApiRequest, injectOpenApiCredentials } from "./openapi";
import { requestDigest, PlatformError } from "../../contracts/contracts";
import { createBoundedFetch, type NetworkAttempt } from "../../infrastructure/connected-network";

export const NATIVE_API_RELEASE = "native-api-v1";
export const NATIVE_API_LIMITS = Object.freeze({ requestBytes: 32768, responseBytes: 1048576, responseDepth: 24, responseNodes: 20000, wallMs: 30000 });
export interface NativeApiOperationRuntime {
  operationId: string; template: RequestTemplate; serverOrigin: string; importDigest: string; policyRevision: number;
  credentialReferences: Record<string, string>; credentials: Record<string, ResolvedOpenApiCredential>;
  effectPolicy: "exact_review" | "owner_reviewed_read";
}
export interface NativeApiOptions {
  deadlineAt: number; signal?: AbortSignal; testLoopback?: boolean;
  beforeAttempt?(attempt: NetworkAttempt): Promise<void>; onAttempt?(attempt: NetworkAttempt): Promise<void>;
}
export interface NativeApiObservation {
  status: number; isError: boolean; contentType: string; text: string; structuredContent?: unknown;
  content: { type: "text" | "binary"; text?: string; mimeType?: string; digest: string }[];
  rawResult: { status: number; headers: Record<string, string>; body: { encoding: "utf8" | "base64"; data: string }; bodyDigest: string };
  resultDigest: string; acquiredAt: string; effect: "unknown"; reviewRequired: true; attempts: NetworkAttempt[];
}
function fail(code: string, message: string): never { throw new PlatformError(code, 400, message); }
function boundedJson(value: unknown): void {
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > NATIVE_API_LIMITS.responseNodes || item.depth > NATIVE_API_LIMITS.responseDepth) fail("API_RESPONSE_LIMIT", "Provider JSON exceeds structural limits");
    if (item.value && typeof item.value === "object") for (const [key, child] of Object.entries(item.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("API_RESPONSE_INVALID", "Provider JSON contains unsafe property names");
      pending.push({ value: child, depth: item.depth + 1 });
    }
  }
}

/** The caller must supply a persisted authorized template and current vault-resolved credentials. */
export async function executeNativeApiOperation(operation: NativeApiOperationRuntime, args: RequestArguments, options: NativeApiOptions): Promise<NativeApiObservation> {
  if (operation.template.serverOrigin !== operation.serverOrigin || operation.template.effect !== "unknown" || !operation.template.reviewRequired) fail("API_TEMPLATE_INVALID", "Operation does not match its fixed server");
  const compiled = compileOpenApiRequest(operation.template, args, operation.credentialReferences);
  const request = injectOpenApiCredentials(compiled, operation.credentials);
  if (Buffer.byteLength(request.body ?? "") > NATIVE_API_LIMITS.requestBytes) fail("API_REQUEST_LIMIT", "Request body exceeds the provider request limit");
  const secrets = Object.values(operation.credentials).flatMap(value => value.type === "api_key" ? [value.value]
    : value.type === "basic" ? [value.password, Buffer.from(`${value.username}:${value.password}`).toString("base64")]
      : [value.token]).filter(value => value.length > 0);
  const attempts: NetworkAttempt[] = [];
  const deadlineAt = Math.min(options.deadlineAt, Date.now() + NATIVE_API_LIMITS.wallMs);
  let admitted = false;
  const fetcher = createBoundedFetch({ authorizeUrl: url => url.href === request.url && url.origin === operation.serverOrigin,
    headers: request.headers, maxRequestBytes: NATIVE_API_LIMITS.requestBytes, maxResponseBytes: NATIVE_API_LIMITS.responseBytes,
    deadlineAt, maxAttempts: 1, maxRequests: 1, signal: options.signal, testLoopback: options.testLoopback,
    returnProviderErrorResponses: true,
    beforeAttempt: async () => {
      if (admitted) fail("API_ATTEMPT_LIMIT", "This native invocation cannot be repeated"); admitted = true;
      await options.beforeAttempt?.({ attempt: 1, status: null, requestBytes: Buffer.byteLength(request.body ?? ""), responseBytes: 0, elapsedMs: 0, outcome: "in_flight" });
    }, onAttempt: async attempt => { attempts.push(attempt); await options.onAttempt?.(attempt); } });
  const response = await fetcher(request.url, { method: request.method, body: request.body, redirect: "error" });
  const bytes = Buffer.from(await response.arrayBuffer()), headers: Record<string, string> = {};
  for (const name of ["content-type", "etag", "last-modified", "retry-after", "request-id", "x-request-id"]) {
    const value = response.headers.get(name); if (value !== null) headers[name] = value.slice(0, 4096);
  }
  const reflection = Buffer.concat([bytes, Buffer.from(JSON.stringify(headers))]);
  if (secrets.some(secret => reflection.includes(Buffer.from(secret)))) fail("API_CREDENTIAL_REFLECTION", "Provider response reflected private credentials");
  const contentType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
  const json = contentType === "application/json" || contentType.endsWith("+json"), textual = json || contentType.startsWith("text/") || !bytes.length;
  const bodyDigest = requestDigest({ encoding: "base64", data: bytes.toString("base64") });
  let text = "", structuredContent: unknown;
  if (textual) {
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return fail("API_RESPONSE_INVALID", "Text provider response is not valid UTF-8"); }
    if (json && text.trim()) {
      try { structuredContent = JSON.parse(text); } catch { return fail("API_RESPONSE_INVALID", "Provider did not return valid JSON"); }
      boundedJson(structuredContent);
    }
  } else text = `Provider returned ${contentType} (${bytes.length} bytes). The complete response is in the private operation receipt.`;
  const rawResult = { status: response.status, headers, body: { encoding: textual ? "utf8" as const : "base64" as const,
    data: textual ? new TextDecoder().decode(bytes) : bytes.toString("base64") }, bodyDigest };
  return { status: response.status, isError: !response.ok, contentType, text,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    content: [{ type: textual ? "text" : "binary", ...(textual ? { text } : { mimeType: contentType }), digest: bodyDigest }],
    rawResult, resultDigest: requestDigest(rawResult), acquiredAt: new Date().toISOString(), effect: "unknown", reviewRequired: true, attempts };
}
