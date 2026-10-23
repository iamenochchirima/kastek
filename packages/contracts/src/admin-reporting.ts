/** Product-owned administrative reporting. Monetary values retain their source currency. */
export type AdminReportProduct = "growth" | "agents" | "agency";
export type AdminReportDomain = "customers" | "adoption" | "usage" | "revenue" | "reliability";
export type AdminReportAvailability = "available" | "partial" | "stale" | "unavailable" | "unsupported";
export interface AdminReportDetail { metric: string; dimensions: Record<string,string> }
export interface AdminReportQuery {
  detail?: AdminReportDetail;
  start: string;
  end: string;
  timezone: string;
  organizationId?: string;
  /** Consuming product for shared execution; never inferred from organization IDs. */
  consumer?: AdminReportProduct;
  view?: "activity" | "customers";
  page: number;
  pageSize: number;
}
export interface AdminMetricDefinition {
  key: string;
  domain: AdminReportDomain;
  label: string;
  unit: "count" | "tokens" | "credits" | "minor" | "micros" | "milliseconds";
  semantics: "current" | "period";
  definition: string;
}
export interface AdminReportMetric {
  detailSupported?: boolean;
  key: string;
  /** Decimal strings preserve exact PostgreSQL bigint totals. Null means unknown, never zero. */
  value: string | null;
  availability: AdminReportAvailability;
  reason?: string;
  currency?: string;
  dimensions?: Record<string, string>;
  source: string;
  observedAt: string | null;
}
export interface AdminReportRecord {
  label?: string;
  id: string;
  kind: string;
  organizationId: string;
  state: string;
  occurredAt: string;
  consumer?: AdminReportProduct;
  rootId?: string;
}
/** Event projection series; never added to authoritative balance or usage totals. */
export interface AdminReportTrend {
  key: string;
  domain?: AdminReportDomain;
  unit: string;
  availability: AdminReportAvailability;
  source: string;
  observedAt: string | null;
  completeThrough: string | null;
  series: {start: string; end: string; value: string | null}[];
  scopeCoverage?: {includedScopeCount:number;totalScopeCount:number;hasMore:boolean};
  reason?: string;
}
export interface AdminProductReport {
  contractVersion: "1";
  product: AdminReportProduct;
  query: AdminReportQuery;
  generatedAt: string;
  sourceObservedAt: string | null;
  /** Only an ingestion/projection checkpoint can supply this field. */
  completeThrough: string | null;
  availability: AdminReportAvailability;
  metrics: AdminReportMetric[];
  trends?: AdminReportTrend[];
  records: AdminReportRecord[];
  hasMore: boolean;
}
export interface AdminCrossProductReport {
  contractVersion: "1";
  generatedAt: string;
  query: AdminReportQuery;
  products: AdminProductReport[];
}
export const ADMIN_REPORT_METRICS: readonly AdminMetricDefinition[] = [
  { key:"organizations", domain:"customers", label:"Organizations", unit:"count", semantics:"current", definition:"Current product-owned organizations, scoped by the requested product organization ID." },
  { key:"memberships", domain:"customers", label:"Memberships", unit:"count", semantics:"current", definition:"Current non-revoked product memberships. This is not a unique cross-product people count." },
  { key:"new_organizations", domain:"customers", label:"New organizations", unit:"count", semantics:"period", definition:"Organizations created in the half-open requested time range." },
  { key:"active_organizations", domain:"adoption", label:"Active organizations", unit:"count", semantics:"period", definition:"Distinct product organizations with a recorded meaningful action in the range; each source documents its action set." },
  { key:"active_users", domain:"adoption", label:"Active users", unit:"count", semantics:"period", definition:"Distinct verified human actors with meaningful recorded actions. Owners inferred from organization activity do not qualify." },
  { key:"agents", domain:"adoption", label:"Agents", unit:"count", semantics:"current", definition:"Current standalone Agents definitions, excluding product-managed execution features." },
  { key:"conversations", domain:"usage", label:"Conversations", unit:"count", semantics:"period", definition:"Conversations created in range; deleted content is never projected." },
  { key:"operations", domain:"usage", label:"Operations", unit:"count", semantics:"period", definition:"Source-recorded operation quantity, preserving product metric dimensions rather than mixing unlike quantities." },
  { key:"runs", domain:"usage", label:"Root tasks", unit:"count", semantics:"period", definition:"Root tasks admitted in range. Child tasks appear in detail and do not increase root task count." },
  { key:"tokens_input", domain:"usage", label:"Input tokens", unit:"tokens", semantics:"period", definition:"Once-accounted model input tokens by operation settlement time, including child work; unknown usage remains partial." },
  { key:"tokens_output", domain:"usage", label:"Output tokens", unit:"tokens", semantics:"period", definition:"Once-accounted model output tokens by operation settlement time, including child work; unknown usage remains partial." },
  { key:"model_cost", domain:"usage", label:"Model cost", unit:"micros", semantics:"period", definition:"Settled model operation cost in source currency by settlement time, counted once by execution owner. Consumer is an attribution dimension, not an additional charge." },
  { key:"unknown_model_operations", domain:"usage", label:"Unknown model costs", unit:"count", semantics:"period", definition:"Model cost settlements whose actual cost remains unknown; never treated as free." },
  { key:"credits", domain:"usage", label:"Credits consumed", unit:"credits", semantics:"period", definition:"Recorded product credit usage. Credits are not revenue or provider cost." },
  { key:"invoiced", domain:"revenue", label:"Invoiced", unit:"minor", semantics:"period", definition:"Issued invoice amount in each currency by source issue timestamp, excluding draft and void records where supported." },
  { key:"paid", domain:"revenue", label:"Paid", unit:"minor", semantics:"period", definition:"Recorded paid invoice amounts per currency by paid timestamp. This is not provider net settlement." },
  { key:"refunds", domain:"revenue", label:"Refunds", unit:"minor", semantics:"period", definition:"Recorded refunds per currency and refund time. A refunded status without amount/time is insufficient." },
  { key:"outstanding", domain:"revenue", label:"Outstanding", unit:"minor", semantics:"current", definition:"Current unpaid issued invoice amounts per currency; period filter does not convert this into historical balance." },
  { key:"failed", domain:"reliability", label:"Failed root tasks", unit:"count", semantics:"period", definition:"Admitted root tasks in the requested cohort whose current state is failed. Other terminal outcomes remain separately visible." },
  { key:"completed", domain:"reliability", label:"Completed root tasks", unit:"count", semantics:"period", definition:"Admitted root tasks in the requested cohort whose current state is completed. Cohorts remain subject to ongoing execution." },
  { key:"backlog", domain:"reliability", label:"Open root tasks", unit:"count", semantics:"current", definition:"Current nonterminal root tasks irrespective of selected period." },
  { key:"oldest_backlog_ms", domain:"reliability", label:"Oldest open task", unit:"milliseconds", semantics:"current", definition:"Age of the oldest currently nonterminal root task; zero only when the source confirms no backlog." },
  { key:"delivery_failures", domain:"reliability", label:"Failed deliveries", unit:"count", semantics:"period", definition:"Authoritatively failed channel deliveries by creation cohort. SMTP acceptance is not confirmed delivery." },
  { key:"handoffs", domain:"reliability", label:"Human handoffs", unit:"count", semantics:"period", definition:"Committed staff takeover commands in range, not inferred from agent failures. Replayed command IDs do not increase the count." },
  { key:"run_latency_p95_ms", domain:"reliability", label:"Root task latency p95", unit:"milliseconds", semantics:"period", definition:"95th percentile creation-to-durable-root-settlement latency for roots settled in the selected period." },
  { key:"dispatch_retries", domain:"reliability", label:"Dispatch retries", unit:"count", semantics:"period", definition:"Sum of durable dispatch attempts after the first, from tasks dispatched in the creation cohort. This is not a model invocation retry count." },
  { key:"child_tasks", domain:"usage", label:"Child tasks", unit:"count", semantics:"period", definition:"Child tasks admitted in the selected period. Root totals exclude these children; usage and cost include their settled operations once." },
  { key:"task_states", domain:"reliability", label:"Root task states", unit:"count", semantics:"period", definition:"Root tasks admitted in range grouped by current durable state. These are the same root cohort, not additional runs." },
  { key:"deliveries", domain:"reliability", label:"Channel deliveries", unit:"count", semantics:"period", definition:"Unique outbound channel segments created in range grouped by current delivery state and channel. Accepted, unknown and delivered remain distinct." },
  { key:"human_replies", domain:"reliability", label:"Human replies", unit:"count", semantics:"period", definition:"Unique committed staff reply commands in range. Replayed command IDs do not increase the count." },
  { key:"subscriptions", domain:"customers", label:"Subscriptions", unit:"count", semantics:"current", definition:"Current product-owned subscriptions grouped by recorded status and plan; credits and external entitlements do not imply a subscription." },
  { key:"clients", domain:"customers", label:"Clients", unit:"count", semantics:"current", definition:"Current Agency-owned client records, scoped to the requested Agency workspace." },
  { key:"payment_failures", domain:"reliability", label:"Failed checkouts", unit:"count", semantics:"period", definition:"Recorded FAILED or ABANDONED checkout records in the creation cohort. Provider settlement and later retries are separate facts." },
  { key:"api_requests", domain:"usage", label:"Developer API requests", unit:"count", semantics:"period", definition:"Recorded Growth Developer API requests in range; not inferred from process logs." },
  { key:"api_failures", domain:"reliability", label:"Developer API failures", unit:"count", semantics:"period", definition:"Recorded Growth Developer API requests in range with HTTP status 500 or above." },
  { key:"connections", domain:"customers", label:"Channel connections", unit:"count", semantics:"current", definition:"Current standalone Agents channel connections grouped by channel and recorded state, without exposing provider credentials." },
] as const;
