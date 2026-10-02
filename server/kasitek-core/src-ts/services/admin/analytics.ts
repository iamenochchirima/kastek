import type { Pool } from "pg";
import { ApiError } from "../../error.js";
import { SerdeFloat, wireInteger } from "@kasitek/server-support/json";
import * as sql from "./analytics-sql.js";
import { COVERAGE } from "./analytics-metadata.js";
export type Row = Record<string, any>;
export interface ReportWindow {
  start: Date;
  end: Date;
  days: number;
}
export function reportWindow(
  requested?: number | bigint | null,
  now = new Date(),
): ReportWindow {
  const value = requested ?? 30;
  if (
    (typeof value !== "bigint" &&
      (typeof value !== "number" || !Number.isSafeInteger(value))) ||
    value < 1 ||
    value > 366
  )
    throw new ApiError(400, "bad_request", "days must be between 1 and 366");
  const days = Number(value),
    start = new Date(now);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  start.setUTCHours(0, 0, 0, 0);
  return { start, end: now, days };
}
export function humanizeKey(value: string): string {
  return value
    .split(/[_\-.]/)
    .filter(Boolean)
    .map((part) => {
      const [first, ...rest] = Array.from(part);
      return first!.toUpperCase() + rest.join("");
    })
    .join(" ");
}
export const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const numeric = new Set([
  "new_organizations",
  "new_users",
  "active_organizations",
  "active_users",
  "operations",
  "failed_operations",
  "revenue_minor",
  "credits_consumed",
  "subscriptions",
  "active_days",
  "conversations",
  "messages",
  "calls",
  "campaign_sends",
  "collected_revenue_minor",
  "refunds_minor",
  "paid_invoices",
  "failed_payments",
  "new_subscriptions",
  "cancellations",
  "value",
  "amount",
]);
export function numericRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      camel(key),
      numeric.has(key) ? wireInteger(BigInt(value)) : value,
    ]),
  );
}
async function rows(
  pool: Pool,
  query: string,
  values: unknown[] = [],
): Promise<Row[]> {
  return (await pool.query(query, values)).rows;
}
async function scalar(
  pool: Pool,
  query: string,
  values: unknown[] = [],
): Promise<bigint> {
  const row = (await pool.query({ text: query, values, rowMode: "array" }))
    .rows[0];
  return BigInt(row?.[0] ?? 0);
}
const args = (w: ReportWindow) => [
  w.start.toISOString().replace(/Z$/, ""),
  w.end.toISOString().replace(/Z$/, ""),
];
function sum(rows: Row[], field: string): bigint {
  return rows.reduce(
    (total, row) => BigInt.asIntN(64, total + BigInt(row[field] ?? 0)),
    0n,
  );
}
async function breakdown(
  pool: Pool,
  query: string,
  values: unknown[],
  humanize = true,
): Promise<Row[]> {
  return (await rows(pool, query, values)).map((row) => ({
    key: row.key,
    label: humanize ? humanizeKey(row.key) : row.key,
    value: wireInteger(BigInt(row.value)),
  }));
}
function common(window: ReportWindow, dataAsOf: Date): Row {
  return {
    range: { ...window, interval: "day" },
    timezone: "UTC",
    source: "core_authoritative",
    dataAsOf,
  };
}
async function overviewDaily(pool: Pool, w: ReportWindow): Promise<Row[]> {
  const fields = [
      "new_organizations",
      "new_users",
      "active_organizations",
      "operations",
      "failed_operations",
      "revenue_minor",
      "credits_consumed",
    ],
    values = new Map<string, Row>();
  for (
    let time = w.start.getTime();
    time <= w.end.getTime();
    time += 86400000
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    values.set(
      date,
      Object.fromEntries([
        ["date", date],
        ...fields.map((key) => [camel(key), 0]),
      ]),
    );
  }
  const queries = [
    sql.LOAD_DAILY_0,
    sql.LOAD_DAILY_1,
    sql.LOAD_DAILY_2,
    sql.LOAD_DAILY_3,
    sql.LOAD_DAILY_4,
    sql.LOAD_DAILY_5,
  ];
  for (let i = 0; i < queries.length; i++)
    for (const row of await rows(pool, queries[i]!, args(w))) {
      const date = (
          row.bucket instanceof Date
            ? row.bucket.toISOString()
            : String(row.bucket)
        ).slice(0, 10),
        point =
          values.get(date) ??
          Object.fromEntries([
            ["date", date],
            ...fields.map((key) => [camel(key), 0]),
          ]);
      if (i === 3) {
        point.operations = wireInteger(BigInt(row.operations));
        point.failedOperations = wireInteger(BigInt(row.failures));
      } else
        point[camel(fields[i < 3 ? i : i + 1]!)] = wireInteger(
          BigInt(row.value),
        );
      values.set(date, point);
    }
  return [...values.values()].sort((a, b) => a.date.localeCompare(b.date));
}
export async function overview(
  pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(),
    w = reportWindow(days),
    daily = await overviewDaily(pool, w),
    names = [
      "totalOrganizations",
      "newOrganizations",
      "activeOrganizations",
      "totalUsers",
      "newUsers",
      "activeUsers",
      "activeSubscriptions",
      "trials",
      "pastDueSubscriptions",
      "collectedRevenueMinor",
      "monthlyRecurringRevenueMinor",
      "failedPayments",
      "operations",
      "failedOperations",
      "creditsConsumed",
    ],
    queries = [
      sql.LOAD_KPIS_0,
      sql.LOAD_KPIS_1,
      sql.LOAD_KPIS_2,
      sql.LOAD_KPIS_3,
      sql.LOAD_KPIS_4,
      sql.LOAD_KPIS_5,
      sql.LOAD_KPIS_6,
      sql.LOAD_KPIS_7,
      sql.LOAD_KPIS_8,
      sql.LOAD_KPIS_9,
      sql.LOAD_KPIS_10,
      sql.LOAD_KPIS_11,
      sql.LOAD_KPIS_12,
      sql.LOAD_KPIS_13,
      sql.LOAD_KPIS_14,
    ],
    kpis: Row = {};
  for (let i = 0; i < queries.length; i++)
    kpis[names[i]!] = wireInteger(
      await scalar(
        pool,
        queries[i]!,
        queries[i]!.includes("$1") ? args(w) : [],
      ),
    );
  return {
    ...common(w, dataAsOf),
    kpis,
    daily,
    productMix: await breakdown(pool, sql.LOAD_PRODUCT_MIX_0, args(w)),
    planMix: (await rows(pool, sql.LOAD_PLAN_MIX_0)).map(numericRow),
    topOrganizations: (
      await rows(pool, sql.LOAD_TOP_ORGANIZATIONS_0, [...args(w), 10])
    ).map(numericRow),
  };
}
export async function usage(
  pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(),
    w = reportWindow(days),
    daily = (await rows(pool, sql.LOAD_USAGE_DAILY_0, args(w))).map(numericRow),
    productMix = await breakdown(pool, sql.LOAD_USAGE_PRODUCT_MIX_0, args(w)),
    metricMix = await breakdown(
      pool,
      sql.LOAD_USAGE_METRIC_MIX_0,
      args(w),
      false,
    ),
    channelMix = await breakdown(pool, sql.LOAD_USAGE_CHANNEL_MIX_0, args(w)),
    campaignFunnel = await breakdown(pool, sql.LOAD_CAMPAIGN_FUNNEL_0, args(w)),
    connectionMix = await breakdown(pool, sql.LOAD_CONNECTION_MIX_0, []),
    creditLifecycle = (
      await rows(pool, sql.LOAD_CREDIT_LIFECYCLE_0, args(w))
    ).map(numericRow),
    delivered = sum(
      campaignFunnel.filter((row) => ["DELIVERED", "READ"].includes(row.key)),
      "value",
    ),
    failed = BigInt(
      campaignFunnel.find((row) => row.key === "FAILED")?.value ?? 0,
    ),
    denominator = BigInt.asIntN(64, delivered + failed),
    kpis: Row = {};
  for (const key of [
    "operations",
    "conversations",
    "messages",
    "calls",
    "campaignSends",
    "creditsConsumed",
  ])
    kpis[key] = wireInteger(sum(daily, key));
  return {
    ...common(w, dataAsOf),
    coverage: COVERAGE.usage,
    kpis: {
      ...kpis,
      deliveredMessages: wireInteger(delivered),
      failedMessages: wireInteger(failed),
      deliveryRate: new SerdeFloat(
        denominator === 0n
          ? 0
          : (Number(delivered) / Number(denominator)) * 100,
      ),
      connections: wireInteger(sum(connectionMix, "value")),
      connectionIssues: wireInteger(
        sum(
          connectionMix.filter((row) =>
            ["NEEDS_ATTENTION", "DISCONNECTED", "REVOKED"].includes(row.key),
          ),
          "value",
        ),
      ),
    },
    daily,
    productMix,
    metricMix,
    channelMix,
    campaignFunnel,
    connectionMix,
    creditLifecycle,
  };
}
export async function revenue(
  pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(),
    w = reportWindow(days),
    daily = (await rows(pool, sql.LOAD_REVENUE_DAILY_0, args(w))).map(
      numericRow,
    ),
    planMix = (await rows(pool, sql.LOAD_PLAN_MIX_0)).map(numericRow),
    paymentOutcomes = await breakdown(pool, sql.REVENUE_0, args(w)),
    invoiceStatus = await breakdown(pool, sql.REVENUE_1, args(w)),
    subscriptionStatus = await breakdown(pool, sql.REVENUE_2, []),
    creditLifecycle = (
      await rows(pool, sql.LOAD_CREDIT_LIFECYCLE_0, args(w))
    ).map(numericRow),
    kpis: Row = {};
  for (const key of [
    "collectedRevenueMinor",
    "refundsMinor",
    "paidInvoices",
    "failedPayments",
    "newSubscriptions",
    "cancellations",
  ])
    kpis[key] = wireInteger(sum(daily, key));
  kpis.monthlyRecurringRevenueMinor = wireInteger(
    await scalar(pool, sql.REVENUE_3),
  );
  kpis.activeSubscriptions = wireInteger(
    sum(
      subscriptionStatus.filter((row) =>
        ["ACTIVE", "PAST_DUE", "GRACE"].includes(row.key),
      ),
      "value",
    ),
  );
  kpis.trials =
    subscriptionStatus.find((row) => row.key === "TRIAL")?.value ?? 0;
  kpis.pastDueSubscriptions =
    subscriptionStatus.find((row) => row.key === "PAST_DUE")?.value ?? 0;
  return {
    ...common(w, dataAsOf),
    coverage: COVERAGE.revenue,
    kpis,
    daily,
    planMix,
    paymentOutcomes,
    invoiceStatus,
    subscriptionStatus,
    creditLifecycle,
  };
}
export async function customers(
  pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(),
    w = reportWindow(days),
    daily = (await rows(pool, sql.LOAD_CUSTOMER_DAILY_0, args(w))).map(
      numericRow,
    ),
    active = await scalar(pool, sql.ACTIVE_ORGANIZATIONS_IN_RANGE_0, args(w)),
    total = await scalar(pool, sql.CUSTOMERS_0),
    totalUsers = await scalar(pool, sql.CUSTOMERS_1),
    activeUsers = await scalar(pool, sql.CUSTOMERS_2, args(w)),
    paying = await scalar(pool, sql.CUSTOMERS_3),
    trials = await scalar(pool, sql.CUSTOMERS_4),
    top = (await rows(pool, cohortSql(false), args(w))).map(numericRow),
    inactiveRows = (await rows(pool, cohortSql(true), args(w))).map(numericRow),
    planMix = await breakdown(pool, sql.LOAD_CUSTOMER_PLAN_MIX_0, [], false),
    inactive = BigInt.asIntN(64, total - active);
  return {
    ...common(w, dataAsOf),
    coverage: COVERAGE.customers,
    kpis: {
      totalOrganizations: wireInteger(total),
      newOrganizations: wireInteger(sum(daily, "newOrganizations")),
      activeOrganizations: wireInteger(active),
      inactiveOrganizations: wireInteger(inactive < 0n ? 0n : inactive),
      activationRate: new SerdeFloat(
        total === 0n ? 0 : (Number(active) / Number(total)) * 100,
      ),
      totalUsers: wireInteger(totalUsers),
      activeUsers: wireInteger(activeUsers),
      payingOrganizations: wireInteger(paying),
      trialOrganizations: wireInteger(trials),
    },
    daily,
    funnel: [
      {
        key: "organizations",
        label: "Organizations",
        value: wireInteger(total),
      },
      { key: "activated", label: "Activated", value: wireInteger(active) },
      { key: "paying", label: "Paying", value: wireInteger(paying) },
    ],
    planMix,
    topOrganizations: top,
    inactiveOrganizations: inactiveRows,
  };
}

function cohortSql(inactive: boolean): string {
  return sql.LOAD_CUSTOMER_COHORTS_0.replace(
    "{}",
    inactive
      ? "HAVING COALESCE(SUM(event.quantity), 0) = 0"
      : "HAVING COALESCE(SUM(event.quantity), 0) > 0",
  ).replace(
    "{}",
    inactive
      ? "operations ASC, active_days ASC, organization.name"
      : "operations DESC, active_days DESC, organization.name",
  );
}
