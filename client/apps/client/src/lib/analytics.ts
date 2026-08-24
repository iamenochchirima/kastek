import { apiUrl } from "@/lib/server-api";

export type AnalyticsSurface = "core" | "tenant_workspace" | "tenant_client";

export type AnalyticsScope = {
  kind: string;
  externalId: string;
};

export type AnalyticsDateRange = {
  range_start: string;
  range_end: string;
  timezone: string;
};

export type AnalyticsComparisonRequest = {
  kind: string;
};

export type AnalyticsReportQueryInput = AnalyticsDateRange & {
  interval?: string;
  metrics?: string[];
  metric_set?: string;
  breakdowns?: string[];
  filters?: Record<string, string[]>;
  include_descendants?: boolean;
  comparison?: AnalyticsComparisonRequest;
};

export type AnalyticsFreshnessDefinition = {
  max_age_seconds: number;
  late_data_window_seconds: number;
};

export type AnalyticsCoverageDefinition = {
  mode: string;
  required_sources: string[];
};

export type AnalyticsMetricDefinition = {
  key: string;
  version: number;
  domain: string;
  owner: string;
  lifecycle: string;
  description: string;
  value_type: string;
  unit: string;
  precision?: number | null;
  sources: string[];
  formula: string;
  eligible_population: string;
  exclusions: string[];
  numerator?: string | null;
  denominator?: string | null;
  time_semantics: string;
  default_aggregation: string;
  temporal_aggregation: string;
  comparison: string;
  deduplication: string;
  descendant_aggregation: string;
  supported_intervals: string[];
  scope_kinds: string[];
  dimensions: string[];
  permissions: string[];
  privacy_class: string;
  exactness: string;
  freshness: AnalyticsFreshnessDefinition;
  coverage: AnalyticsCoverageDefinition;
  availability: string;
  effective_from: string;
  applicability?: string | null;
  replacement?: string | null;
  dependencies: string[];
};

export type AnalyticsDimensionDefinition = {
  key: string;
  type: string;
  source: string;
  compatible_metrics: string[];
  filterable: boolean;
  groupable: boolean;
  cardinality: string;
  privacy_class: string;
  stable_key: boolean;
  permissions: string[];
};

export type AnalyticsMetricSetDefinition = {
  key: string;
  version: number;
  owner: string;
  lifecycle: string;
  description: string;
  metrics: string[];
  default_interval: string;
  scope_kinds: string[];
  permissions: string[];
};

export type AnalyticsCatalog = {
  scope: AnalyticsScope;
  scope_kind: string;
  timezone: string;
  registry_version: string;
  registry_sha256: string;
  metrics: AnalyticsMetricDefinition[];
  dimensions: AnalyticsDimensionDefinition[];
  metric_sets: AnalyticsMetricSetDefinition[];
};

export type AnalyticsAvailability = {
  state: string;
  reason: string | null;
};

export type AnalyticsCoverage = {
  state: string;
  included_points: number;
  expected_points: number | null;
  evidence_layer: string | null;
  window_start: string | null;
  window_end: string | null;
  complete_through: string | null;
  projection_state: string;
  projection_source_state: string;
  required_sources: string[];
  dimension_state: string;
  missing_dimension_points: number;
};

export type AnalyticsFreshness = {
  state: string;
  latest_source_timestamp: string | null;
  max_age_seconds: number;
};

export type AnalyticsReportPoint = {
  bucket_start: string;
  bucket_end: string;
  dimensions: unknown;
  value: number | null;
  numerator: number | null;
  denominator: number | null;
};

export type AnalyticsMetricResult = {
  key: string;
  version: number;
  unit: string;
  value_type: string;
  exactness: string;
  availability: AnalyticsAvailability;
  coverage: AnalyticsCoverage;
  freshness: AnalyticsFreshness;
  warnings: string[];
  series: AnalyticsReportPoint[];
};

export type AnalyticsComparisonMetric = {
  key: string;
  version: number;
  series: AnalyticsReportPoint[];
};

export type AnalyticsReportComparison = {
  kind: string;
  range_start: string;
  range_end: string;
  metrics: AnalyticsComparisonMetric[];
};

export type AnalyticsReport = {
  scope: AnalyticsScope;
  scope_kind: string;
  range_start: string;
  range_end: string;
  interval: string;
  timezone: string;
  generated_at: string;
  data_as_of: string | null;
  generation_id: number | null;
  projection_version: string;
  registry_sha256: string;
  metrics: AnalyticsMetricResult[];
  comparison: AnalyticsReportComparison | null;
};

export type AnalyticsGatewayPaths = {
  catalog: string;
  query: string;
};

export function analyticsGatewayPaths(surface: AnalyticsSurface = "core"): AnalyticsGatewayPaths {
  if (surface === "tenant_client") {
    return {
      catalog: "/api/client/analytics/catalog",
      query: "/api/client/analytics/query",
    };
  }

  return {
    catalog: "/api/analytics/catalog",
    query: "/api/analytics/query",
  };
}

export class AnalyticsRequestError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AnalyticsRequestError";
  }

  public get unavailable() {
    return this.status === 502 || this.status === 503 || this.status === 504 || this.status >= 500;
  }
}

type RequestOptions = {
  path: string;
  signal?: AbortSignal;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

  const response = await fetch(apiUrl(path), {
    ...init,
    cache: "no-store",
    credentials: "include",
    headers,
  });
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = typeof body?.error === "string" ? body.error : "Analytics request failed";
    const code = typeof body?.code === "string" ? body.code : undefined;
    throw new AnalyticsRequestError(detail, response.status, code);
  }

  return body as T;
}

export function fetchAnalyticsCatalog(options: Partial<RequestOptions> = {}): Promise<AnalyticsCatalog> {
  return request<AnalyticsCatalog>(options.path ?? analyticsGatewayPaths().catalog, {
    signal: options.signal,
  });
}

export function fetchAnalyticsReport(
  input: AnalyticsReportQueryInput,
  options: Partial<RequestOptions> = {},
): Promise<AnalyticsReport> {
  return request<AnalyticsReport>(options.path ?? analyticsGatewayPaths().query, {
    method: "POST",
    body: JSON.stringify(input),
    signal: options.signal,
  });
}

export function resolveAnalyticsTimezone(timezone?: string | null): string {
  const normalized = timezone?.trim();
  return normalized || "UTC";
}

export function createAnalyticsDateRange(options: {
  days?: number;
  now?: Date;
  timezone?: string | null;
} = {}): AnalyticsDateRange {
  const now = options.now ?? new Date();
  if (Number.isNaN(now.getTime())) throw new Error("Analytics date range requires a valid date");

  const days = Math.min(366, Math.max(1, Math.floor(options.days ?? 30)));
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    range_start: start.toISOString(),
    range_end: now.toISOString(),
    timezone: resolveAnalyticsTimezone(options.timezone),
  };
}

export function formatAnalyticsTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "—" : timestamp.toLocaleString();
}
