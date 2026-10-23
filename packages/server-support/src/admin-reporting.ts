import type { AdminReportQuery, AdminProductReport, AdminReportMetric } from "@kasitek-labs/contracts";

/** Match the existing Analytics API range and pagination safety bounds. */
export function parseAdminReportQuery(input: Record<string, unknown>, now = new Date()): AdminReportQuery {
  const allowed = new Set(["start", "end", "timezone", "organizationId", "consumer", "page", "pageSize"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Unknown report filter");
  const date = (value: unknown, fallback: Date) => {
    if (value === undefined) return fallback.toISOString();
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Use a UTC timestamp");
    const normalized = new Date(value).toISOString();
    if (normalized.slice(0,10) !== value.slice(0,10)) throw new Error("Invalid calendar date");
    return normalized;
  };
  const end = date(input.end, now);
  const start = date(input.start, new Date(Date.parse(end) - 30 * 86400000));
  if (Date.parse(start) >= Date.parse(end) || Date.parse(end) - Date.parse(start) > 366 * 86400000) throw new Error("Report range must be positive and at most 366 days");
  const timezone = input.timezone ?? "UTC";
  if (typeof timezone !== "string" || timezone.length > 64) throw new Error("Invalid timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new Error("Invalid timezone"); }
  const integer = (value: unknown, fallback: number, max: number) => {
    if (value === undefined) return fallback;
    if (!(typeof value === "number" && Number.isSafeInteger(value) || typeof value === "string" && /^[1-9]\d*$/.test(value))) throw new Error("Invalid pagination");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new Error("Invalid pagination");
    return parsed;
  };
  if (input.organizationId !== undefined && (typeof input.organizationId !== "string" || !input.organizationId.trim() || input.organizationId.length > 200)) throw new Error("Invalid organization");
  if (input.consumer !== undefined && !["growth", "agents", "agency"].includes(String(input.consumer))) throw new Error("Invalid consumer");
  return {start,end,timezone, ...(input.organizationId === undefined ? {} : {organizationId:input.organizationId as string}),
    ...(input.consumer === undefined ? {} : {consumer:input.consumer as AdminReportQuery["consumer"]}),
    page:integer(input.page,1,10000),pageSize:integer(input.pageSize,50,100)};
}
export function reportMetric(key: string, value: string | number | bigint | null, source: string, observedAt: string | null, extra: Partial<AdminReportMetric> = {}): AdminReportMetric {
  return {key,value:value === null ? null : String(value),source,observedAt,availability:value === null ? "unsupported" : "available",...extra};
}
export function missingProductReport(product: AdminProductReport["product"], query: AdminReportQuery, reason: string): AdminProductReport {
  return {contractVersion:"1",product,query,generatedAt:new Date().toISOString(),sourceObservedAt:null,completeThrough:null,
    availability:"unavailable",metrics:[reportMetric("source",null,product,null,{availability:"unavailable",reason})],records:[],hasMore:false};
}
export function reportCsv(reports: readonly AdminProductReport[]): string {
  const cell = (value: unknown) => {
    let raw = value === null || value === undefined ? "" : String(value);
    if (/^[\s]*[=+\-@\t\r]/.test(raw)) raw = "'" + raw;
    return '"' + raw.replaceAll('"','""') + '"';
  };
  const rows: unknown[][] = [["product","start","end","timezone","organization","metric","value","currency","dimensions","availability","reason","source","observed_at","complete_through"]];
  for (const report of reports) for (const metric of report.metrics) rows.push([report.product,report.query.start,report.query.end,report.query.timezone,
    report.query.organizationId,metric.key,metric.value,metric.currency,JSON.stringify(metric.dimensions ?? {}),metric.availability,metric.reason,metric.source,metric.observedAt,report.completeThrough]);
  return rows.map(row=>row.map(cell).join(",")).join("\r\n") + "\r\n";
}
