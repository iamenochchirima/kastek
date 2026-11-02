import test from "node:test";
import assert from "node:assert/strict";
import type { AdminReportMetric, AdminMetricDefinition } from "@kasitek-labs/contracts";
import { exactMetricValue, reportingParams, reportTimestamp, trendChartValues, reportDetailFromSearch, metricDetailScope } from "../src/lib/admin-report-format";

const metric = (value: string | null, currency?: string): AdminReportMetric => ({ key: "test", value, currency, availability: "available", source: "fixture", observedAt: null });
const definition = (unit: AdminMetricDefinition["unit"]): AdminMetricDefinition => ({ key: "test", unit, domain: "usage", label: "Test", semantics: "period", definition: "Fixture" });

test("reporting values preserve integers beyond JavaScript safe range", () => {
  assert.equal(exactMetricValue(metric("9007199254740993123456")), "9,007,199,254,740,993,123,456");
  assert.equal(exactMetricValue(metric("0"), definition("count")), "0");
  assert.equal(exactMetricValue(metric(null)), "Unavailable");
  assert.equal(exactMetricValue({ ...metric("0"), availability: "unsupported" }), "Unavailable");
});
test("monetary values preserve source currency and its minor exponent", () => {
  assert.equal(exactMetricValue(metric("12345", "ZAR"), definition("minor")), "ZAR 123.45");
  assert.equal(exactMetricValue(metric("12345", "JPY"), definition("minor")), "JPY 12,345");
  assert.equal(exactMetricValue(metric("12345", "KWD"), definition("minor")), "KWD 12.345");
  assert.equal(exactMetricValue(metric("-1", "USD"), definition("micros")), "USD -0.000001");
  assert.equal(exactMetricValue(metric("12345"), definition("minor")), "12,345 minor units");
});
test("report filters retain scope, period, timezone and bounded record page", () => {
  const scope = { product: "growth" as const, start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z", timezone: "Africa/Johannesburg", organizationId: "org&one", page: 2, pageSize: 50 };
  const params = reportingParams(scope, "usage");
  for (const [key, value] of Object.entries(scope)) assert.equal(params.get(key), String(value));
  assert.equal(params.get("domain"), "usage");
});
test("source timestamps use selected timezone without claiming ingestion freshness", () => {
  assert.equal(reportTimestamp(null, "UTC"), "Unknown");
  assert.notEqual(reportTimestamp("2026-10-01T23:30:00Z", "UTC"), reportTimestamp("2026-10-01T23:30:00Z", "Africa/Johannesburg"));
});

test("trend charts retain gaps and never round unsafe integers", () => {
  const trend = { key: "test", unit: "count", availability: "partial" as const, source: "fixture", observedAt: null, completeThrough: null, series: [{start: "a", end: "b", value: "12"}, {start: "b", end: "c", value: null}, {start: "c", end: "d", value: "0"}] };
  assert.deepEqual(trendChartValues(trend), [12, null, 0]);
  assert.equal(trendChartValues({...trend, series:[{start:"a",end:"b",value:"9007199254740993123456"}]}), null);
  assert.equal(trendChartValues({...trend, availability:"unavailable"}), null);
  assert.equal(trendChartValues({...trend, series:[{start:"a",end:"b",value:null}]}), null);
});

test("metric drill-down retains product, organization, dates, timezone and exact dimensions",()=>{
 const scope={product:"all" as const,start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z",timezone:"Africa/Johannesburg",page:4,pageSize:50};
 const detail=metricDetailScope(scope,{...metric("15","USD"),key:"model_cost",dimensions:{consumer:"growth",provider:"openrouter",model:"fixture",exactness:"usage_estimate"}});
 assert.equal(detail.product,"all");assert.equal(detail.page,1);assert.equal(detail.start,scope.start);assert.equal(detail.end,scope.end);assert.equal(detail.timezone,scope.timezone);
 assert.deepEqual(detail.detail,{metric:"model_cost",dimensions:{consumer:"growth",provider:"openrouter",model:"fixture",exactness:"usage_estimate",currency:"USD"}});
 assert.deepEqual(reportDetailFromSearch(reportingParams(detail)),detail.detail);
 assert.equal(reportDetailFromSearch(new URLSearchParams({detail:'{'})),undefined);
 assert.equal(reportDetailFromSearch(new URLSearchParams({detail:JSON.stringify({metric:"runs",dimensions:{secret:{}}})})),undefined);
});
