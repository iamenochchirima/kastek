import { lookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { publicAddress } from "./connected-network";

export type ModelNetworkFailure = "DESTINATION_DENIED" | "PRIVATE_ADDRESS_DENIED" | "REQUEST_LIMIT" | "RESPONSE_LIMIT" |
  "DEADLINE" | "CONNECT_TIMEOUT" | "IDLE_TIMEOUT" | "PROGRESS_TIMEOUT" | "CANCELLED" | "AUTHORIZATION_DENIED" |
  "NETWORK_UNAVAILABLE" | "ENCODING_DENIED" | "RESPONSE_INVALID";
export class ModelNetworkError extends Error {
  constructor(readonly code: ModelNetworkFailure, readonly dispatched: boolean) { super(code); this.name = "ModelNetworkError"; }
}
export interface ModelNetworkPolicy {
  authorizeUrl: (url: URL) => boolean;
  headers?: Record<string, string>;
  maxRequestBytes: number; maxResponseBytes: number; deadlineAt: number;
  signal?: AbortSignal;
  beforeDispatch?: () => void | Promise<void>;
  connectTimeoutMs?: number; idleTimeoutMs?: number; progressTimeoutMs?: number;
  /** Explicit HTTP loopback fixtures only; never inferred from environment. */
  testLoopback?: boolean;
}
export type ModelFetch = typeof fetch & { markProgress: () => void };
const callerHeaders = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta"]);

/** A single physical model request. Body bytes stream under the same authority
 * and deadline as dispatch; progress is reported by the semantic model adapter. */
export function createModelFetch(inputPolicy: ModelNetworkPolicy): ModelFetch {
  const policy = { ...inputPolicy, headers: { ...inputPolicy.headers } };
  let used = false, progress: (() => void) | undefined;
  const modelFetch = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (used) throw new ModelNetworkError("REQUEST_LIMIT", false);
    let dispatched = false, settled = false, ended = false;
    let outgoing: ClientRequest | undefined, incoming: IncomingMessage | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let rejectResponse: (error: ModelNetworkError) => void = () => {};
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const signal = AbortSignal.any([policy.signal, init.signal].filter((value): value is AbortSignal => !!value));
    const error = (code: ModelNetworkFailure) => new ModelNetworkError(code, dispatched);
    const clear = (name: string) => { const timer = timers.get(name); if (timer) clearTimeout(timer); timers.delete(name); };
    const cleanup = () => { for (const name of timers.keys()) clear(name); signal.removeEventListener("abort", cancel); progress = undefined; };
    const fail = (code: ModelNetworkFailure) => {
      if (ended) return;
      ended = true; cleanup();
      const failure = error(code);
      if (settled) controller?.error(failure); else rejectResponse(failure);
      outgoing?.destroy(); incoming?.destroy();
    };
    const arm = (name: string, duration: number | undefined, code: ModelNetworkFailure) => {
      clear(name);
      if (ended || duration === undefined || duration === 0 && name !== "total") return;
      const deadline = Date.now() + duration;
      const check = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) fail(code);
        else timers.set(name, setTimeout(check, Math.min(remaining, 2_147_483_647)));
      };
      check();
    };
    const cancel = () => fail("CANCELLED");
    const stopped = () => {
      if (signal.aborted) throw error("CANCELLED");
      if (ended || Date.now() >= policy.deadlineAt) throw error("DEADLINE");
    };
    try {
      if (input instanceof Request || !Number.isSafeInteger(policy.maxRequestBytes) || policy.maxRequestBytes < 0 ||
          !Number.isSafeInteger(policy.maxResponseBytes) || policy.maxResponseBytes < 0 || !Number.isSafeInteger(policy.deadlineAt) ||
          [policy.connectTimeoutMs, policy.idleTimeoutMs, policy.progressTimeoutMs].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) throw error("REQUEST_LIMIT");
      used = true; stopped();
      const url = new URL(input);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const local = policy.testLoopback === true && ["127.0.0.1", "::1", "localhost"].includes(hostname);
      if ((!local && (url.protocol !== "https:" || !!url.port && url.port !== "443")) ||
          (local && !["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.hash || !policy.authorizeUrl(url)) throw error("DESTINATION_DENIED");
      if (init.body !== undefined && init.body !== null && typeof init.body !== "string" && !(init.body instanceof Uint8Array)) throw error("REQUEST_LIMIT");
      const body = Buffer.from(init.body === undefined || init.body === null ? "" : init.body as string | Uint8Array);
      if (body.length > policy.maxRequestBytes) throw error("REQUEST_LIMIT");
      const headers: Record<string, string> = {};
      for (const [name, value] of new Headers(init.headers)) if (callerHeaders.has(name)) headers[name] = value;
      for (const [name, value] of Object.entries(policy.headers)) headers[name.toLowerCase()] = value;
      headers["accept-encoding"] = "identity";
      headers["content-length"] = String(body.length);
      if (Object.keys(headers).some(name => ["host", "connection", "transfer-encoding"].includes(name))) throw error("REQUEST_LIMIT");
      if (Object.entries(headers).some(([name, value]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value))) throw error("REQUEST_LIMIT");

      return await new Promise<Response>((resolve, reject) => {
        rejectResponse = reject;
        signal.addEventListener("abort", cancel, { once: true });
        arm("total", policy.deadlineAt - Date.now(), "DEADLINE");
        arm("connect", policy.connectTimeoutMs, "CONNECT_TIMEOUT");
        if (ended) return;
        const resolved = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : lookup(hostname, { all: true, verbatim: true });
        void resolved.then(async addresses => {
          stopped();
          if (!addresses.length || addresses.some(item => !publicAddress(item.address) && !(local && ["127.0.0.1", "::1"].includes(item.address)))) throw error("PRIVATE_ADDRESS_DENIED");
          try { await policy.beforeDispatch?.(); } catch { throw error("AUTHORIZATION_DENIED"); }
          stopped();
          if (!policy.authorizeUrl(url)) throw error("DESTINATION_DENIED");
          const address = addresses[0]!;
          const send = url.protocol === "https:" ? httpsRequest : httpRequest;
          outgoing = send(url, { method: init.method ?? (init.body ? "POST" : "GET"), headers, agent: false,
            ...(url.protocol === "https:" ? { rejectUnauthorized: true, servername: hostname } : {}),
            family: address.family, lookup: (_host, _options, callback) => callback(null, address.address, address.family) }, response => {
            incoming = response;
            if (ended) { response.destroy(); return; }
            const encoding = response.headers["content-encoding"];
            if (encoding && encoding.toLowerCase() !== "identity") { fail("ENCODING_DENIED"); return; }
            const length = response.headers["content-length"];
            if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { fail("RESPONSE_INVALID"); return; }
            if (length !== undefined && Number(length) > policy.maxResponseBytes) { fail("RESPONSE_LIMIT"); return; }
            const status = response.statusCode ?? 502;
            if (status >= 300 && status < 400) { fail("DESTINATION_DENIED"); return; }
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) if (value !== undefined && !["set-cookie", "authorization", "proxy-authenticate"].includes(name)) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            let bytes = 0;
            const stream = new ReadableStream<Uint8Array>({
              start(value) { controller = value; },
              pull() { response.resume(); },
              cancel() { fail("CANCELLED"); },
            }, { highWaterMark: 1 });
            response.on("data", (chunk: Buffer) => {
              if (ended) return;
              arm("idle", policy.idleTimeoutMs, "IDLE_TIMEOUT");
              bytes += chunk.length;
              if (bytes > policy.maxResponseBytes) { fail("RESPONSE_LIMIT"); return; }
              controller!.enqueue(new Uint8Array(chunk));
              if ((controller!.desiredSize ?? 0) <= 0) response.pause();
            });
            response.once("aborted", () => fail("NETWORK_UNAVAILABLE"));
            response.once("error", () => fail("NETWORK_UNAVAILABLE"));
            response.once("end", () => {
              if (ended) return;
              if (length !== undefined && bytes !== Number(length)) { fail("RESPONSE_INVALID"); return; }
              ended = true; cleanup(); controller!.close();
            });
            settled = true;
            const result = new Response([204, 205, 304].includes(status) ? null : stream, { status, headers: responseHeaders });
            Object.defineProperty(result, "url", { value: url.href });
            resolve(result);
          });
          outgoing.once("socket", socket => {
            socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => {
              clear("connect"); arm("idle", policy.idleTimeoutMs, "IDLE_TIMEOUT");
              progress = () => arm("progress", policy.progressTimeoutMs, "PROGRESS_TIMEOUT"); progress();
            });
          });
          outgoing.once("error", () => fail("NETWORK_UNAVAILABLE"));
          stopped(); dispatched = true; outgoing.end(body);
        }).catch(failure => fail(failure instanceof ModelNetworkError ? failure.code : "NETWORK_UNAVAILABLE"));
      });
    } catch (failure) {
      cleanup(); outgoing?.destroy(); incoming?.destroy();
      throw failure instanceof ModelNetworkError ? failure : error("NETWORK_UNAVAILABLE");
    }
  }) as ModelFetch;
  modelFetch.markProgress = () => progress?.();
  return modelFetch;
}
