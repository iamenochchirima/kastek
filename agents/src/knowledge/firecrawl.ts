import { withProviderSpan } from "../telemetry/spans";

export interface FirecrawlMapLink {
  url: string;
  title?: string;
  description?: string;
}

export interface FirecrawlMapResult {
  links: FirecrawlMapLink[];
}

export interface FirecrawlPage {
  markdown?: string;
  html?: string;
  links?: string[];
  metadata?: {
    title?: string;
    description?: string;
    language?: string;
    sourceURL?: string;
    url?: string;
    statusCode?: number;
    [key: string]: unknown;
  };
}

export interface FirecrawlCrawlStatus {
  status: string;
  total?: number;
  completed?: number;
  creditsUsed?: number;
  next?: string | null;
  data: FirecrawlPage[];
}

export interface FirecrawlClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export interface FirecrawlMapOptions {
  url: string;
  limit?: number;
  includeSubdomains?: boolean;
  ignoreQueryParameters?: boolean;
  sitemap?: "include" | "skip" | "only";
}

export interface FirecrawlCrawlOptions {
  url: string;
  limit?: number;
  maxDiscoveryDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
  allowSubdomains?: boolean;
  delaySeconds?: number;
  maxConcurrency?: number;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function normalizeMapLinks(value: unknown): FirecrawlMapLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [{ url: entry }];
    const record = asRecord(entry);
    return typeof record.url === "string"
      ? [{
        url: record.url,
        ...(typeof record.title === "string" ? { title: record.title } : {}),
        ...(typeof record.description === "string" ? { description: record.description } : {}),
      }]
      : [];
  });
}

function normalizePage(value: unknown): FirecrawlPage | null {
  const record = asRecord(value);
  const metadata = asRecord(record.metadata);
  if (typeof record.markdown !== "string" && typeof record.html !== "string") return null;
  return {
    ...(typeof record.markdown === "string" ? { markdown: record.markdown } : {}),
    ...(typeof record.html === "string" ? { html: record.html } : {}),
    links: Array.isArray(record.links) ? record.links.filter((link): link is string => typeof link === "string") : [],
    metadata: {
      ...(typeof metadata.title === "string" ? { title: metadata.title } : {}),
      ...(typeof metadata.description === "string" ? { description: metadata.description } : {}),
      ...(typeof metadata.language === "string" ? { language: metadata.language } : {}),
      ...(typeof metadata.sourceURL === "string" ? { sourceURL: metadata.sourceURL } : {}),
      ...(typeof metadata.url === "string" ? { url: metadata.url } : {}),
      ...(typeof metadata.statusCode === "number" ? { statusCode: metadata.statusCode } : {}),
      ...metadata,
    },
  };
}

/**
 * Thin provider adapter. The rest of the application only depends on this
 * contract, which keeps a future self-hosted Crawlee implementation possible.
 */
export class FirecrawlClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  public constructor(options: FirecrawlClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.firecrawl.dev");
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 60_000, 120_000));
    this.fetcher = options.fetcher ?? fetch;
  }

  public isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  private async request(pathOrUrl: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    if (!this.isConfigured()) throw new Error("Website crawler is not configured");
    return withProviderSpan("firecrawl", "http.request", async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
        const response = await this.fetcher(url, {
          ...init,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            accept: "application/json",
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(init.headers ?? {}),
          },
        });
        const payload = asRecord(await response.json().catch(() => ({})));
        if (!response.ok) {
          const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
          throw new Error(`Firecrawl request failed: ${detail}`);
        }
        return payload;
      } catch (error) {
        if (controller.signal.aborted) throw new Error("Firecrawl request timed out");
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  public async map(options: FirecrawlMapOptions): Promise<FirecrawlMapResult> {
    const payload = await this.request("/v2/map", {
      method: "POST",
      body: JSON.stringify({
        url: options.url,
        limit: Math.max(1, Math.min(options.limit ?? 100, 5_000)),
        includeSubdomains: options.includeSubdomains ?? false,
        ignoreQueryParameters: options.ignoreQueryParameters ?? true,
        sitemap: options.sitemap ?? "include",
      }),
    });
    return { links: normalizeMapLinks(payload.links) };
  }

  public async startCrawl(options: FirecrawlCrawlOptions): Promise<{ id: string; url: string }> {
    const payload = await this.request("/v2/crawl", {
      method: "POST",
      body: JSON.stringify({
        url: options.url,
        limit: Math.max(1, Math.min(options.limit ?? 100, 1_000)),
        maxDiscoveryDepth: Math.max(0, Math.min(options.maxDiscoveryDepth ?? 3, 10)),
        ...(options.includePaths?.length ? { includePaths: options.includePaths } : {}),
        ...(options.excludePaths?.length ? { excludePaths: options.excludePaths } : {}),
        allowSubdomains: options.allowSubdomains ?? false,
        ...(options.delaySeconds !== undefined ? { delay: Math.max(0, Math.min(options.delaySeconds, 30)) } : {}),
        ...(options.maxConcurrency !== undefined ? { maxConcurrency: Math.max(1, Math.min(options.maxConcurrency, 20)) } : {}),
        ignoreQueryParameters: true,
        ignoreRobotsTxt: false,
        scrapeOptions: {
          formats: ["markdown"],
          onlyMainContent: true,
          blockAds: true,
          removeBase64Images: true,
          parsers: ["pdf"],
        },
      }),
    });
    if (typeof payload.id !== "string" || typeof payload.url !== "string") throw new Error("Firecrawl returned an invalid crawl job");
    return { id: payload.id, url: payload.url };
  }

  public async getCrawlStatus(id: string): Promise<FirecrawlCrawlStatus> {
    let payload = await this.request(`/v2/crawl/${encodeURIComponent(id)}`);
    const pages: FirecrawlPage[] = [];
    for (let page = 0; page < 20; page += 1) {
      const data = Array.isArray(payload.data) ? payload.data.flatMap((entry) => {
        const normalized = normalizePage(entry);
        return normalized ? [normalized] : [];
      }) : [];
      pages.push(...data);
      if (typeof payload.next !== "string" || !payload.next) break;
      payload = await this.request(payload.next);
    }
    return {
      status: typeof payload.status === "string" ? payload.status : "unknown",
      ...(typeof payload.total === "number" ? { total: payload.total } : {}),
      ...(typeof payload.completed === "number" ? { completed: payload.completed } : {}),
      ...(typeof payload.creditsUsed === "number" ? { creditsUsed: payload.creditsUsed } : {}),
      ...(typeof payload.next === "string" ? { next: payload.next } : { next: null }),
      data: pages,
    };
  }

  public async cancelCrawl(id: string): Promise<void> {
    await this.request(`/v2/crawl/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
