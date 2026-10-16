const metricKeys = [
  ["conversation.messages.received@1", "Messages received", "count"],
  ["campaign.recipients.delivered@1", "Campaign deliveries", "count"],
  ["agent.runs.completed@1", "Completed agent runs", "count"],
  ["connection.health_checks@1", "Connection health checks", "count"],
  ["campaign.delivery_rate@1", "Campaign delivery rate", "percent"],
  ["conversation.response_time_ms@1", "Conversation response time", "milliseconds"],
  ["agent.runs.failed@1", "Failed agent runs", "count"],
] as const;

const timestamps = Array.from({ length: 30 }, (_, index) => {
  const bucketStart = new Date(Date.UTC(2026, 6, 27 + index));
  const bucketEnd = new Date(Date.UTC(2026, 6, 28 + index));
  return [bucketStart.toISOString(), bucketEnd.toISOString()] as const;
});

export function analyticsCatalogFixture() {
  return {
    scope: { kind: "organization", externalId: "e2e-organization" },
    scope_kind: "organization",
    timezone: "UTC",
    registry_version: "e2e-registry",
    registry_sha256: "e2e-registry-sha256",
    metrics: metricKeys.map(([key, label, unit]) => ({
      key: key.slice(0, key.lastIndexOf("@")),
      version: 1,
      domain: key.split(".")[0],
      owner: "e2e",
      lifecycle: "active",
      description: label,
      value_type: "number",
      unit,
      precision: unit === "percent" ? 2 : 0,
      sources: ["e2e.source"],
      formula: "e2e fixture",
      eligible_population: "e2e population",
      exclusions: [],
      numerator: null,
      denominator: null,
      time_semantics: "occurred_at",
      default_aggregation: "sum",
      temporal_aggregation: "sum",
      comparison: "period",
      deduplication: "event_id",
      descendant_aggregation: "sum",
      supported_intervals: ["day"],
      scope_kinds: ["organization"],
      dimensions: [],
      permissions: ["analytics.read"],
      privacy_class: "aggregate",
      exactness: "exact",
      freshness: { max_age_seconds: 3600, late_data_window_seconds: 86400 },
      coverage: { mode: "complete", required_sources: ["e2e.source"] },
      availability: "available",
      effective_from: "2026-01-01T00:00:00.000Z",
      applicability: null,
      replacement: null,
      dependencies: [],
    })),
    dimensions: [],
    metric_sets: [{
      key: "overview.summary",
      version: 1,
      owner: "e2e",
      lifecycle: "active",
      description: "Workspace overview fixture",
      metrics: metricKeys.map(([key]) => key),
      default_interval: "day",
      scope_kinds: ["organization"],
      permissions: ["analytics.read"],
    }],
  };
}

export type AnalyticsReportFixtureVariant = "populated" | "empty" | "zero" | "partial" | "sparse";

export function analyticsReportFixture(variant: AnalyticsReportFixtureVariant = "populated") {
  return {
    scope: { kind: "organization", externalId: "e2e-organization" },
    scope_kind: "organization",
    range_start: "2026-07-26T00:00:00.000Z",
    range_end: "2026-08-25T00:00:00.000Z",
    interval: "day",
    timezone: "UTC",
    generated_at: "2026-08-25T12:00:00.000Z",
    data_as_of: "2026-08-25T11:55:00.000Z",
    generation_id: 42,
    projection_version: "e2e-projection",
    registry_sha256: "e2e-registry-sha256",
    metrics: metricKeys.map(([key, , unit], index) => ({
      key: key.slice(0, key.lastIndexOf("@")),
      version: 1,
      unit,
      value_type: "number",
      exactness: "exact",
      availability: { state: "available", reason: null },
      coverage: {
        state: "complete",
        included_points: timestamps.length,
        expected_points: timestamps.length,
        evidence_layer: "e2e",
        window_start: timestamps[0][0],
        window_end: timestamps[timestamps.length - 1][1],
        complete_through: timestamps[timestamps.length - 1][1],
        projection_state: "current",
        projection_source_state: "current",
        required_sources: ["e2e.source"],
        dimension_state: "complete",
        missing_dimension_points: 0,
      },
      freshness: {
        state: "fresh",
        latest_source_timestamp: "2026-08-25T11:55:00.000Z",
        max_age_seconds: 3600,
      },
      warnings: [],
      series: timestamps.map(([bucket_start, bucket_end], pointIndex) => ({
        bucket_start,
        bucket_end,
        dimensions: {},
        value: fixtureValue({ variant, unit, index, pointIndex }),
        numerator: unit === "percent" ? 189 + pointIndex : null,
        denominator: unit === "percent" ? 200 : null,
      })),
    })),
    comparison: null,
  };
}

function fixtureValue({
  variant,
  unit,
  index,
  pointIndex,
}: {
  variant: AnalyticsReportFixtureVariant;
  unit: string;
  index: number;
  pointIndex: number;
}) {
  if (variant === "empty" || (variant === "partial" && index > 0) || (variant === "sparse" && pointIndex === 1)) return null;
  if (variant === "zero") return 0;
  return unit === "percent" ? 94.5 + pointIndex : unit === "milliseconds" ? 820 + pointIndex * 40 : 42 + index + pointIndex;
}
