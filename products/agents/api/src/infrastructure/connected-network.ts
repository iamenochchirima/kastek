import ipaddr from "ipaddr.js";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export type NetworkFailureCode = "DESTINATION_DENIED" | "PRIVATE_ADDRESS_DENIED" | "REQUEST_LIMIT" | "RESPONSE_LIMIT" | "DEADLINE" | "CANCELLED" | "RATE_LIMIT" | "AUTHENTICATION" | "NETWORK_UNAVAILABLE" | "ENCODING_DENIED";
export class ConnectedNetworkError extends Error {
  constructor(public readonly code: NetworkFailureCode, public readonly retryAfterMs?: number) { super(code); }
}
export interface NetworkAttempt { attempt: number; status: number | null; requestBytes: number; responseBytes: number; elapsedMs: number; outcome: string; phase?: "setup" | "read" }
export interface TrustedNetworkPolicy {
  authorizeUrl: (url: URL) => boolean;
  headers?: Record<string, string>;
  maxRequestBytes: number;
  maxResponseBytes: number;
  responseProfile?: "native-read-v1" | "source-import-v1";
  deadlineAt: number;
  maxAttempts?: number;
  maxRequests?: number;
  signal?: AbortSignal;
  beforeAttempt?: () => void | Promise<void>;
  onAttempt?: (attempt: NetworkAttempt) => unknown | Promise<unknown>;
  /** Explicit loopback-only HTTP fixture profile, never inferred from NODE_ENV. */
  testLoopback?: boolean;
}
export function publicAddress(address: string): boolean {
  try { const parsed = ipaddr.process(address); return parsed.range() === "unicast"; } catch { return false; }
}
function stopped(policy: TrustedNetworkPolicy): void {
  if (policy.signal?.aborted) throw new ConnectedNetworkError("CANCELLED");
  if (Date.now() >= policy.deadlineAt) throw new ConnectedNetworkError("DEADLINE");
}
function authorize(url: URL, policy: TrustedNetworkPolicy): void {
  const loopback = policy.testLoopback && url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((!loopback && (url.protocol !== "https:" || url.port && url.port !== "443")) || url.username || url.password || url.hash || !policy.authorizeUrl(url)) throw new ConnectedNetworkError("DESTINATION_DENIED");
}
async function addresses(url: URL, policy: TrustedNetworkPolicy) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const result = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  const local = policy.testLoopback && ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!result.length || result.some(item => !publicAddress(item.address) && !(local && ["127.0.0.1", "::1"].includes(item.address)))) throw new ConnectedNetworkError("PRIVATE_ADDRESS_DENIED");
  return result[0]!;
}
const callerHeaders = new Set(["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id", "if-none-match"]);
function headersFor(input: HeadersInit | undefined, policy: TrustedNetworkPolicy): Record<string, string> {
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  for (const [key, value] of new Headers(input)) if (callerHeaders.has(key)) headers[key] = value;
  for (const [key, value] of Object.entries(policy.headers ?? {})) headers[key.toLowerCase()] = value;
  if (Object.entries(headers).some(([key, value]) => key.length + value.length > 8192 || /[\r\n]/.test(value)) || Buffer.byteLength(JSON.stringify(headers)) > 16384) throw new ConnectedNetworkError("REQUEST_LIMIT");
  return headers;
}
async function physical(url: URL, init: RequestInit, body: Buffer, policy: TrustedNetworkPolicy, progress: (bytes: number) => void): Promise<Response> {
  stopped(policy); authorize(url, policy);
  const address = await new Promise<{ address: string; family: number }>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); policy.signal?.removeEventListener("abort", cancel); };
    const cancel = () => { finish(); reject(new ConnectedNetworkError("CANCELLED")); };
    const timer = setTimeout(() => { finish(); reject(new ConnectedNetworkError("DEADLINE")); }, Math.max(1, policy.deadlineAt - Date.now()));
    policy.signal?.addEventListener("abort", cancel, { once: true });
    addresses(url, policy).then(value => { finish(); resolve(value); }, error => { finish(); reject(error); });
  });
  stopped(policy);
  return new Promise<Response>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, { method: init.method ?? "GET", headers: headersFor(init.headers, policy), agent: false, family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family) }, response => {
      const chunks: Buffer[] = []; let size = 0;
      if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { response.destroy(new ConnectedNetworkError("ENCODING_DENIED")); return; }
      const declared = Number(response.headers["content-length"]);
      if (Number.isFinite(declared) && declared > policy.maxResponseBytes) { response.destroy(new ConnectedNetworkError("RESPONSE_LIMIT")); return; }
      response.on("data", (chunk: Buffer) => { size += chunk.length; progress(size); if (size > policy.maxResponseBytes) response.destroy(new ConnectedNetworkError("RESPONSE_LIMIT")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && !["set-cookie", "authorization"].includes(key)) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
        const status = response.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    const timer = setTimeout(() => request.destroy(new ConnectedNetworkError("DEADLINE")), Math.max(1, policy.deadlineAt - Date.now()));
    const cancel = () => request.destroy(new ConnectedNetworkError("CANCELLED"));
    policy.signal?.addEventListener("abort", cancel, { once: true });
    request.once("close", () => { clearTimeout(timer); policy.signal?.removeEventListener("abort", cancel); });
    request.once("error", error => reject(error instanceof ConnectedNetworkError ? error : new ConnectedNetworkError("NETWORK_UNAVAILABLE")));
    if (body.length) request.write(body); request.end();
  });
}
export function createBoundedFetch(policy: TrustedNetworkPolicy): typeof fetch {
  policy = { ...policy, deadlineAt: Math.min(policy.deadlineAt, Date.now() + 30000), maxRequestBytes: Math.min(policy.maxRequestBytes, 32768), maxResponseBytes: Math.min(policy.maxResponseBytes, policy.responseProfile === "source-import-v1" ? 10485760 : 2097152), maxRequests: Math.min(policy.maxRequests ?? 16, 32) };
  let requests = 0;
  return async (input, init = {}) => {
    stopped(policy);
    if (input instanceof Request) throw new ConnectedNetworkError("REQUEST_LIMIT");
    const url = new URL(input);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string" && !(init.body instanceof Uint8Array)) throw new ConnectedNetworkError("REQUEST_LIMIT");
    const body = Buffer.from(init.body === undefined || init.body === null ? "" : init.body as string | Uint8Array);
    if (body.length > policy.maxRequestBytes) throw new ConnectedNetworkError("REQUEST_LIMIT");
    const maximum = Math.min(3, Math.max(1, policy.maxAttempts ?? 1));
    let current = url, redirects = 0;
    for (let attempt = 1; attempt <= maximum; attempt++) {
      stopped(policy);
      if (++requests > (policy.maxRequests ?? 16)) throw new ConnectedNetworkError("REQUEST_LIMIT");
      await policy.beforeAttempt?.();
      stopped(policy);
      const start = Date.now(); let response: Response, observedBytes = 0;
      try { response = await physical(current, init, body, policy, bytes => { observedBytes = bytes; }); }
      catch (error) {
        await policy.onAttempt?.({ attempt, status: null, requestBytes: body.length, responseBytes: observedBytes, elapsedMs: Date.now() - start, outcome: error instanceof ConnectedNetworkError ? error.code : "NETWORK_UNAVAILABLE" });
        // A transport failure can follow a completed remote read; callers receive an explicit outcome rather than an invisible repeat.
        throw error instanceof ConnectedNetworkError ? error : new ConnectedNetworkError("NETWORK_UNAVAILABLE");
      }
      const bytes = observedBytes;
      await policy.onAttempt?.({ attempt, status: response.status, requestBytes: body.length, responseBytes: bytes, elapsedMs: Date.now() - start, outcome: "response" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (init.redirect === "error") throw new ConnectedNetworkError("DESTINATION_DENIED");
        if (init.redirect === "manual") { Object.defineProperty(response,"url",{value:current.href}); return response; }
        if (++redirects > 3 || !response.headers.has("location")) throw new ConnectedNetworkError("DESTINATION_DENIED");
        const next = new URL(response.headers.get("location")!, current); authorize(next, policy);
        if (next.origin !== url.origin && Object.keys(policy.headers ?? {}).some(key => key.toLowerCase() === "authorization")) throw new ConnectedNetworkError("DESTINATION_DENIED");
        current = next; attempt--; continue;
      }
      const rawRetry = response.headers.get("retry-after");
      const retryDate = rawRetry !== null && /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(rawRetry) ? Date.parse(rawRetry) : NaN;
      const explicitRetryMs = rawRetry === null ? undefined : /^\d+$/.test(rawRetry) ? Number(rawRetry) * 1000 : Number.isFinite(retryDate) ? Math.max(0,retryDate-Date.now()) : undefined;
      const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
      const rateLimited = response.status === 429 || response.status === 403 && (exhausted || explicitRetryMs !== undefined);
      if (response.status === 401 || response.status === 403 && !rateLimited) throw new ConnectedNetworkError("AUTHENTICATION");
      if (rateLimited || [502, 503, 504].includes(response.status)) {
        const rawReset = exhausted ? response.headers.get("x-ratelimit-reset") : null;
        const resetSeconds = rawReset !== null && /^\d+$/.test(rawReset) ? Number(rawReset) : NaN;
        const resetMs = Number.isSafeInteger(resetSeconds) && Number.isSafeInteger(resetSeconds*1000) ? Math.max(0,resetSeconds*1000-Date.now()) : undefined;
        // Exhausted quotas have no safe default delay: wait for a declared reset or fail explicitly.
        const fallback = exhausted || rawRetry !== null && explicitRetryMs === undefined ? Infinity : 250*attempt;
        const retryAfterMs = Math.max(explicitRetryMs ?? resetMs ?? fallback,resetMs ?? 0);
        if (attempt === maximum || !Number.isFinite(retryAfterMs) || retryAfterMs >= policy.deadlineAt - Date.now()) throw new ConnectedNetworkError(rateLimited ? "RATE_LIMIT" : "NETWORK_UNAVAILABLE", Number.isFinite(retryAfterMs)?retryAfterMs:undefined);
        await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { policy.signal?.removeEventListener("abort", cancel); resolve(); }, retryAfterMs); const cancel = () => { clearTimeout(timer); reject(new ConnectedNetworkError("CANCELLED")); }; policy.signal?.addEventListener("abort", cancel, { once: true }); });
        continue;
      }
      Object.defineProperty(response, "url", { value: current.href });
      Object.defineProperty(response, "redirected", { value: redirects > 0 });
      return response;
    }
    throw new ConnectedNetworkError("NETWORK_UNAVAILABLE");
  };
}
