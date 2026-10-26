import { isIP } from "node:net";
import { z } from "zod";
import { publicAddress } from "../../../infrastructure/connected-network";

const configuration = z.object({
  AGENTS_FIRECRAWL_URL: z.url(),
  AGENTS_FIRECRAWL_API_KEY: z.string().trim().min(1).optional(),
  AGENTS_FIRECRAWL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(2147483647).default(60000),
});
export type FirecrawlConfig = { url: string; apiKey?: string; timeoutMs: number };
export function loadFirecrawlConfig(environment: NodeJS.ProcessEnv = process.env): FirecrawlConfig | undefined {
  if (!environment.AGENTS_FIRECRAWL_URL?.trim()) {
    if (environment.AGENTS_FIRECRAWL_API_KEY?.trim()) throw new Error("AGENTS_FIRECRAWL_URL is required with a key");
    return undefined;
  }
  const value = configuration.parse({ ...environment, AGENTS_FIRECRAWL_URL: environment.AGENTS_FIRECRAWL_URL.trim(), AGENTS_FIRECRAWL_API_KEY: environment.AGENTS_FIRECRAWL_API_KEY?.trim() || undefined });
  const url = new URL(value.AGENTS_FIRECRAWL_URL);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("AGENTS_FIRECRAWL_URL must be an HTTP(S) origin");
  if (url.hostname === "api.firecrawl.dev" && (url.protocol !== "https:" || !value.AGENTS_FIRECRAWL_API_KEY)) throw new Error("Firecrawl Cloud requires HTTPS and an API key");
  if (value.AGENTS_FIRECRAWL_API_KEY && url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Use HTTPS when transmitting a Firecrawl key");
  return { url: url.origin, apiKey: value.AGENTS_FIRECRAWL_API_KEY, timeoutMs: value.AGENTS_FIRECRAWL_TIMEOUT_MS };
}
export class FirecrawlError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); }
}
const page = z.object({ markdown: z.string().max(10 * 1024 * 1024).optional(), metadata: z.record(z.string(), z.unknown()).optional() });
export type FirecrawlPage = z.infer<typeof page>;
const jobId = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
function publicUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash || url.href.length > 2048 || host === "localhost" || host.endsWith(".localhost") || isIP(host) && !publicAddress(host)) throw new FirecrawlError("FIRECRAWL_TARGET_DENIED");
  return url.href;
}

/** Provider transport only. Callers own source admission, tenant scope, cancellation and publication. */
export class FirecrawlClient {
  constructor(private readonly config: FirecrawlConfig) {}
  private async request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const stop = AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])]);
    try {
      const response = await fetch(`${this.config.url}${path}`, { method, redirect: "error", signal: stop,
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}) },
        body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) { await response.body?.cancel(); throw new FirecrawlError(response.status === 401 || response.status === 403 ? "FIRECRAWL_AUTHENTICATION" : response.status === 429 ? "FIRECRAWL_RATE_LIMIT" : "FIRECRAWL_HTTP_FAILED", response.status); }
      if (!response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw new FirecrawlError("FIRECRAWL_RESPONSE_INVALID"); }
      const reader = response.body?.getReader();
      if (!reader) throw new FirecrawlError("FIRECRAWL_RESPONSE_INVALID");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > 10 * 1024 * 1024) throw new FirecrawlError("FIRECRAWL_RESPONSE_LIMIT"); chunks.push(result.value); }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (value?.success !== true) throw new FirecrawlError("FIRECRAWL_RESPONSE_INVALID");
      return value;
    } catch (error) {
      if (error instanceof FirecrawlError) throw error;
      if (stop.aborted) throw new FirecrawlError(signal?.aborted ? "FIRECRAWL_CANCELLED" : "FIRECRAWL_TIMEOUT");
      throw new FirecrawlError("FIRECRAWL_UNAVAILABLE");
    }
  }
  async scrape(url: string, signal?: AbortSignal): Promise<FirecrawlPage> {
    const response = await this.request("/v2/scrape", "POST", { url: publicUrl(url), formats: ["markdown"], onlyMainContent: true, timeout: Math.max(1000, this.config.timeoutMs - 1000) }, signal);
    const parsed = z.object({ data: page }).safeParse(response);
    if (!parsed.success || !parsed.data.data.markdown?.trim()) throw new FirecrawlError("FIRECRAWL_CONTENT_EMPTY");
    return parsed.data.data;
  }
  async startCrawl(url: string, options: { limit: number; maxDiscoveryDepth: number }, signal?: AbortSignal): Promise<{ id: string }> {
    const limits = z.object({ limit: z.number().int().min(1), maxDiscoveryDepth: z.number().int().min(0) }).parse(options);
    const response = await this.request("/v2/crawl", "POST", { url: publicUrl(url), ...limits, allowExternalLinks: false, allowSubdomains: false, ignoreRobotsTxt: false, scrapeOptions: { formats: ["markdown"], onlyMainContent: true } }, signal);
    const parsed = z.object({ id: jobId }).safeParse(response);
    if (!parsed.success) throw new FirecrawlError("FIRECRAWL_RESPONSE_INVALID");
    return parsed.data;
  }
  async status(id: string, signal?: AbortSignal) {
    const response = await this.request(`/v2/crawl/${jobId.parse(id)}`, "GET", undefined, signal);
    const parsed = z.object({ status: z.enum(["scraping", "completed", "failed", "cancelled"]), total: z.number().int().nonnegative(), completed: z.number().int().nonnegative(), data: z.array(page), next: z.string().nullable().optional() }).safeParse(response);
    if (!parsed.success) throw new FirecrawlError("FIRECRAWL_RESPONSE_INVALID");
    // Surface pagination explicitly. Never follow provider-supplied URLs with our credential.
    return parsed.data;
  }
  async cancel(id: string, signal?: AbortSignal): Promise<void> { await this.request(`/v2/crawl/${jobId.parse(id)}`, "DELETE", undefined, signal); }
}
