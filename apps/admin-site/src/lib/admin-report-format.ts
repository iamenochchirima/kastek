import type { AdminReportMetric, AdminMetricDefinition, AdminReportQuery, AdminReportTrend, AdminReportDetail } from "@kasitek-labs/contracts";

export type ReportScope = AdminReportQuery & { product: "all" | "growth" | "agents" | "agency" };

export function reportingParams(scope: ReportScope, domain = "overview") {
  const result = new URLSearchParams({ product: scope.product, domain, start: scope.start, end: scope.end, timezone: scope.timezone, page: String(scope.page), pageSize: String(scope.pageSize) });
  if (scope.organizationId) result.set("organizationId", scope.organizationId);
  if (scope.detail) result.set("detail", JSON.stringify(scope.detail));
  return result;
}

function groupedInteger(value: string) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function exactMetricValue(metric: AdminReportMetric, definition?: AdminMetricDefinition) {
  if (metric.value === null || metric.availability === "unavailable" || metric.availability === "unsupported") return "Unavailable";
  if (!/^-?\d+$/.test(metric.value)) return metric.value;
  const negative = metric.value.startsWith("-");
  const digits = metric.value.replace(/^-/, "");
  if (definition?.unit === "minor" || definition?.unit === "micros") {
    let places = 6;
    if (definition.unit === "minor") {
      if (!metric.currency) return `${groupedInteger(metric.value)} minor units`;
      try { places = new Intl.NumberFormat("en", { style: "currency", currency: metric.currency }).resolvedOptions().maximumFractionDigits ?? 2; }
      catch { return `${groupedInteger(metric.value)} minor units`; }
    }
    const padded = digits.padStart(places + 1, "0");
    const amount = places ? `${groupedInteger(padded.slice(0, -places))}.${padded.slice(-places)}` : groupedInteger(padded);
    return `${metric.currency ?? "Currency unknown"} ${negative ? "-" : ""}${amount}`;
  }
  const suffix = definition?.unit === "milliseconds" ? " ms" : definition?.unit === "tokens" ? " tokens" : definition?.unit === "credits" ? " credits" : "";
  return `${negative ? "-" : ""}${groupedInteger(digits)}${suffix}`;
}

export function reportTimestamp(value: string | null, timezone: string) {
  if (!value) return "Unknown";
  try { return new Intl.DateTimeFormat("en-ZA", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(new Date(value)); }
  catch { return value; }
}

/** Plot only exact safe integers. The table remains authoritative for every bucket. */
export function trendChartValues(trend: AdminReportTrend): Array<number | null> | null {
  if (trend.availability === "unsupported" || trend.availability === "unavailable") return null;
  const values: Array<number | null> = [];
  for (const bucket of trend.series) {
    if (bucket.value === null) { values.push(null); continue; }
    if (!/^-?\d+$/.test(bucket.value)) return null;
    const value = Number(bucket.value);
    if (!Number.isSafeInteger(value)) return null;
    values.push(value);
  }
  return values.some((value) => value !== null) ? values : null;
}

/** URL state is validated again by the reporting boundary before any source request. */
export function reportDetailFromSearch(params:URLSearchParams):AdminReportDetail|undefined {
 const raw=params.get('detail');if(!raw||raw.length>2048)return;
 try{const detail=JSON.parse(raw);if(!detail||typeof detail.metric!=='string'||!detail.dimensions||Array.isArray(detail.dimensions)||typeof detail.dimensions!=='object'||Object.values(detail.dimensions).some(value=>typeof value!=='string'))return;return {metric:detail.metric,dimensions:detail.dimensions};}catch{return;}
}
export function metricDetailScope(scope:ReportScope,metric:AdminReportMetric):ReportScope {
 return {...scope,page:1,detail:{metric:metric.key,dimensions:{...metric.dimensions,...(metric.currency?{currency:metric.currency}:{})}}};
}
