import type { Pool } from "pg";
import { ApiError } from "../../error.js";
import { SerdeFloat, wireInteger } from "@kasitek-labs/server-support/json";
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

const args = (w: ReportWindow) => [w.start.toISOString(), w.end.toISOString()];

function common(window: ReportWindow, dataAsOf: Date): Row {
  return {
    range: { ...window, interval: "day" },
    timezone: "UTC",
    source: "growth_authoritative_records",
    dataAsOf,
  };
}

interface DayPoint {
  date: string;
  newOrganizations: number;
  newUsers: number;
  activeOrganizations: number;
  operations: number;
  failedOperations: number;
  conversations: number;
  messages: number;
}

function emptyDay(date: string): DayPoint {
  return {
    date,
    newOrganizations: 0,
    newUsers: 0,
    activeOrganizations: 0,
    operations: 0,
    failedOperations: 0,
    conversations: 0,
    messages: 0,
  };
}

async function dailyPoints(pool: Pool, w: ReportWindow): Promise<DayPoint[]> {
  const dates = new Map<string, DayPoint>();
  for (let time = w.start.getTime(); time <= w.end.getTime(); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    dates.set(date, emptyDay(date));
  }
  const add = (date: string, field: keyof DayPoint, value: unknown) => {
    const point = dates.get(date) ?? emptyDay(date);
    (point[field] as number) = Number(value ?? 0);
    dates.set(date, point);
  };
  const series = async (
    table: string,
    timeColumn: string,
    field: keyof DayPoint,
    where = "",
  ) => {
    const result = await rows(
      pool,
      `SELECT to_char(date_trunc('day', "${timeColumn}"), 'YYYY-MM-DD') AS date,
              count(*)::text AS value
         FROM "${table}"
        WHERE "${timeColumn}" >= $1 AND "${timeColumn}" < $2 ${where}
        GROUP BY 1`,
      args(w),
    );
    for (const row of result) add(String(row.date), field, row.value);
  };
  await series("Organization", "createdAt", "newOrganizations");
  await series("User", "createdAt", "newUsers");
  await series("Conversation", "createdAt", "conversations");
  await series("Message", "createdAt", "messages");
  await series("PublicApiRequest", "createdAt", "operations");
  await series(
    "PublicApiRequest",
    "createdAt",
    "failedOperations",
    `AND "statusCode">=500`,
  );
  const active = await rows(
    pool,
    `SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS date,
            count(DISTINCT "orgId")::text AS value
       FROM "PublicApiRequest"
      WHERE "createdAt" >= $1 AND "createdAt" < $2
      GROUP BY 1`,
    args(w),
  );
  for (const row of active)
    add(String(row.date), "activeOrganizations", row.value);
  return [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export async function overview(
  pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(),
    w = reportWindow(days),
    daily = await dailyPoints(pool, w),
    totalOrganizations = await scalar(pool, `SELECT count(*) FROM "Organization"`),
    totalUsers = await scalar(pool, `SELECT count(*) FROM "User"`),
    activeOrganizations = await scalar(
      pool,
      `SELECT count(DISTINCT "orgId") FROM "PublicApiRequest"
        WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      args(w),
    ),
    operations = await scalar(
      pool,
      `SELECT count(*) FROM "PublicApiRequest"
        WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      args(w),
    ),
    failedOperations = await scalar(
      pool,
      `SELECT count(*) FROM "PublicApiRequest"
        WHERE "createdAt" >= $1 AND "createdAt" < $2 AND "statusCode">=500`,
      args(w),
    ),
    newOrganizations = daily.reduce((sum, point) => sum + point.newOrganizations, 0),
    newUsers = daily.reduce((sum, point) => sum + point.newUsers, 0),
    topOrganizations = await rows(
      pool,
      `SELECT o.id AS key, o.name, count(r.id)::text AS value
         FROM "Organization" o
         LEFT JOIN "PublicApiRequest" r ON r."orgId"=o.id
           AND r."createdAt" >= $1 AND r."createdAt" < $2
        GROUP BY o.id, o.name
        ORDER BY count(r.id) DESC, o.name LIMIT 10`,
      args(w),
    );
  return {
    ...common(w, dataAsOf),
    kpis: {
      totalOrganizations: wireInteger(totalOrganizations),
      newOrganizations: wireInteger(newOrganizations),
      activeOrganizations: wireInteger(activeOrganizations),
      totalUsers: wireInteger(totalUsers),
      newUsers: wireInteger(newUsers),
      activeUsers: wireInteger(activeOrganizations),
      activeSubscriptions: "0",
      trials: "0",
      pastDueSubscriptions: "0",
      collectedRevenueMinor: "0",
      monthlyRecurringRevenueMinor: "0",
      failedPayments: "0",
      operations: wireInteger(operations),
      failedOperations: wireInteger(failedOperations),
      creditsConsumed: "0",
    },
    daily: daily.map((point) => ({
      ...point,
      revenueMinor: "0",
      creditsConsumed: "0",
    })),
    productMix: [],
    planMix: [],
    topOrganizations: topOrganizations.map((row) => ({
      ...row,
      value: wireInteger(BigInt(row.value)),
    })),
  };
}

export async function usage(
  pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(),
    w = reportWindow(days),
    daily = await dailyPoints(pool, w),
    operations = await scalar(
      pool,
      `SELECT count(*) FROM "PublicApiRequest"
        WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      args(w),
    ),
    conversations = await scalar(
      pool,
      `SELECT count(*) FROM "Conversation"
        WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      args(w),
    ),
    messages = await scalar(
      pool,
      `SELECT count(*) FROM "Message"
        WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      args(w),
    );
  return {
    ...common(w, dataAsOf),
    coverage: COVERAGE.usage,
    kpis: {
      operations: wireInteger(operations),
      conversations: wireInteger(conversations),
      messages: wireInteger(messages),
      calls: "0",
      campaignSends: "0",
      creditsConsumed: "0",
      deliveredMessages: "0",
      failedMessages: "0",
      deliveryRate: new SerdeFloat(0),
      connections: "0",
      connectionIssues: "0",
    },
    daily: daily.map((point) => ({
      date: point.date,
      operations: wireInteger(point.operations),
      conversations: wireInteger(point.conversations),
      messages: wireInteger(point.messages),
      calls: "0",
      campaignSends: "0",
      creditsConsumed: "0",
    })),
    productMix: [],
    metricMix: [],
    channelMix: [],
    campaignFunnel: [],
    connectionMix: [],
    creditLifecycle: [],
  };
}

export async function revenue(
  _pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(), w = reportWindow(days);
  return {
    ...common(w, dataAsOf),
    coverage: COVERAGE.revenue,
    kpis: {
      collectedRevenueMinor: "0",
      refundsMinor: "0",
      monthlyRecurringRevenueMinor: "0",
      paidInvoices: "0",
      failedPayments: "0",
      activeSubscriptions: "0",
      trials: "0",
      pastDueSubscriptions: "0",
      newSubscriptions: "0",
      cancellations: "0",
    },
    daily: [],
    planMix: [],
    paymentOutcomes: [],
    invoiceStatus: [],
    subscriptionStatus: [],
    creditLifecycle: [],
    unavailableReason: "Revenue is owned by the central billing service",
  };
}

export async function customers(
  pool: Pool,
  days?: number | bigint | null,
): Promise<Row> {
  const dataAsOf = new Date(),
    w = reportWindow(days),
    daily = await dailyPoints(pool, w),
    total = await scalar(pool, `SELECT count(*) FROM "Organization"`),
    totalUsers = await scalar(pool, `SELECT count(*) FROM "User"`),
    active = await scalar(
      pool,
      `SELECT count(DISTINCT "orgId") FROM "PublicApiRequest"
        WHERE "createdAt" >= $1 AND "createdAt" < $2`,
      args(w),
    ),
    top = await rows(
      pool,
      `SELECT o.id, o.name, count(r.id)::text AS activity
         FROM "Organization" o
         LEFT JOIN "PublicApiRequest" r ON r."orgId"=o.id
           AND r."createdAt" >= $1 AND r."createdAt" < $2
        GROUP BY o.id, o.name
        ORDER BY count(r.id) DESC, o.name LIMIT 20`,
      args(w),
    );
  const inactive = total - active;
  return {
    ...common(w, dataAsOf),
    coverage: COVERAGE.customers,
    kpis: {
      totalOrganizations: wireInteger(total),
      newOrganizations: wireInteger(
        daily.reduce((sum, point) => sum + point.newOrganizations, 0),
      ),
      activeOrganizations: wireInteger(active),
      inactiveOrganizations: wireInteger(inactive < 0n ? 0n : inactive),
      activationRate: new SerdeFloat(
        total === 0n ? 0 : (Number(active) / Number(total)) * 100,
      ),
      totalUsers: wireInteger(totalUsers),
      activeUsers: wireInteger(active),
      payingOrganizations: "0",
      trialOrganizations: "0",
    },
    daily: daily.map((point) => ({
      date: point.date,
      newOrganizations: wireInteger(point.newOrganizations),
      activeOrganizations: wireInteger(point.activeOrganizations),
    })),
    funnel: [
      { key: "organizations", label: "Organizations", value: wireInteger(total) },
      {
        key: "active",
        label: "Active organizations",
        value: wireInteger(active),
      },
    ],
    topOrganizations: top.map((row) => ({
      id: row.id,
      name: row.name,
      activity: wireInteger(BigInt(row.activity)),
    })),
    inactiveOrganizations: [],
    planMix: [],
  };
}
