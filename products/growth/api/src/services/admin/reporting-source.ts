import type { Pool, PoolClient } from "pg";
import type { AdminProductReport, AdminReportQuery } from "@kasitek-labs/contracts";
import { ADMIN_REPORT_METRICS } from "@kasitek-labs/contracts";
import {
  adminReportSnapshot,
  reportMetric,
} from "@kasitek-labs/server-support/admin-reporting";

const growthDetailDefinitions = {
  organizations: { table: '"Organization"', org: "id", time: '"createdAt"', state: "'current'", kind: "organization", period: false },
  new_organizations: { table: '"Organization"', org: "id", time: '"createdAt"', state: "'current'", kind: "organization", period: true },
  memberships: { table: '"OrganizationMember"', org: '"orgId"', time: '"createdAt"', state: "role::text", kind: "membership", period: false },
  active_organizations: { table: '"PublicApiRequest"', org: '"orgId"', time: '"createdAt"', state: "'active'", kind: "organization", period: true },
  conversations: { table: '"Conversation"', org: '"orgId"', time: '"createdAt"', state: "'current'", kind: "conversation", period: true },
  api_requests: { table: '"PublicApiRequest"', org: '"orgId"', time: '"createdAt"', state: '"statusCode"::text', kind: "api_request", period: true },
  api_failures: { table: '"PublicApiRequest"', org: '"orgId"', time: '"createdAt"', state: '"statusCode"::text', kind: "api_request", period: true, where: '"statusCode">=500' },
} satisfies Record<
  string,
  {
    table: string;
    org: string;
    time: string;
    state: string;
    kind: string;
    period: boolean;
    where?: string;
    dimensions?: Record<string, string>;
  }
>;
type GrowthDetailDefinition = {
  table: string;
  org: string;
  time: string;
  state: string;
  kind: string;
  period: boolean;
  where?: string;
  dimensions?: Record<string, string>;
};

async function growthMetricRecords(db: PoolClient, q: AdminReportQuery) {
  const detail = q.detail!;
  if (!Object.hasOwn(growthDetailDefinitions, detail.metric)) return [];
  const d = growthDetailDefinitions[
    detail.metric as keyof typeof growthDetailDefinitions
  ] as GrowthDetailDefinition;
  const dimensions = d.dimensions ?? {};
  if (
    Object.keys(detail.dimensions).length !== Object.keys(dimensions).length ||
    Object.keys(dimensions).some((key) => !Object.hasOwn(detail.dimensions, key))
  )
    return [];
  const args: unknown[] = [q.start, q.end, q.organizationId ?? null];
  const filters = [
    `($3::text IS NULL OR ${d.org}=$3)`,
    ...(d.period
      ? [`${d.time}>=$1 AND ${d.time}<$2`]
      : ["$1::timestamptz IS NOT NULL AND $2::timestamptz IS NOT NULL"]),
    ...(d.where ? [d.where] : []),
  ];
  for (const [key, column] of Object.entries(dimensions)) {
    args.push(detail.dimensions[key]);
    filters.push(`${column}=$${args.length}`);
  }
  args.push(q.pageSize + 1, (q.page - 1) * q.pageSize);
  return (
    await db.query(
      `SELECT id,${d.org} AS "orgId",${d.state} AS status,${d.time} AS "issuedAt",
              $${args.length + 1}::text AS kind
         FROM ${d.table}
        WHERE ${filters.join(" AND ")}
        ORDER BY ${d.time} DESC,id
        LIMIT $${args.length - 1} OFFSET $${args.length}`,
      [...args, d.kind],
    )
  ).rows;
}

export async function growthAdminReport(
  pool: Pool,
  q: AdminReportQuery,
): Promise<AdminProductReport> {
  return adminReportSnapshot(pool, async (db) => {
    const args = [q.start, q.end, q.organizationId ?? null];
    const counts = (
      await db.query(
        `SELECT
           (SELECT count(*) FROM "Organization" WHERE ($3::text IS NULL OR id=$3)) AS organizations,
           (SELECT count(*) FROM "Organization" WHERE ($3::text IS NULL OR id=$3) AND "createdAt">=$1 AND "createdAt"<$2) AS new_organizations,
           (SELECT count(*) FROM "OrganizationMember" WHERE ($3::text IS NULL OR "orgId"=$3)) AS memberships,
           (SELECT count(DISTINCT "orgId") FROM "PublicApiRequest" WHERE ($3::text IS NULL OR "orgId"=$3) AND "createdAt">=$1 AND "createdAt"<$2) AS active_organizations,
           (SELECT count(*) FROM "Conversation" WHERE ($3::text IS NULL OR "orgId"=$3) AND "createdAt">=$1 AND "createdAt"<$2) AS conversations,
           (SELECT max("updatedAt") FROM "Organization" WHERE ($3::text IS NULL OR id=$3)) AS organizations_observed,
           (SELECT max("updatedAt") FROM "OrganizationMember" WHERE ($3::text IS NULL OR "orgId"=$3)) AS memberships_observed,
           (SELECT max("createdAt") FROM "Conversation" WHERE ($3::text IS NULL OR "orgId"=$3)) AS conversations_observed,
           (SELECT max("createdAt") FROM "PublicApiRequest" WHERE ($3::text IS NULL OR "orgId"=$3)) AS active_observed`,
        args,
      )
    ).rows[0];
    const source = "growth.authoritative_records";
    const metrics = Object.entries(counts)
      .filter(([key]) => !key.endsWith("_observed"))
      .map(([key, value]) =>
        reportMetric(
          key,
          String(value),
          source,
          (
            counts[
              (key === "new_organizations" ? "organizations" : key) +
                "_observed"
            ] ?? null
          )?.toISOString() ?? null,
          key === "active_organizations"
            ? { reason: "Organizations with recorded authenticated public API requests" }
            : {},
        ),
      );
    const extra = (
      await db.query(
        `SELECT
           (SELECT count(*) FROM "PublicApiRequest" WHERE "createdAt">=$1 AND "createdAt"<$2 AND ($3::text IS NULL OR "orgId"=$3)) AS api_requests,
           (SELECT count(*) FROM "PublicApiRequest" WHERE "createdAt">=$1 AND "createdAt"<$2 AND "statusCode">=500 AND ($3::text IS NULL OR "orgId"=$3)) AS api_failures,
           (SELECT max("createdAt") FROM "PublicApiRequest" WHERE ($3::text IS NULL OR "orgId"=$3)) AS api_observed`,
        args,
      )
    ).rows[0];
    for (const key of ["api_requests", "api_failures"])
      metrics.push(
        reportMetric(
          key,
          String(extra[key]),
          "growth.PublicApiRequest",
          extra.api_observed?.toISOString() ?? null,
        ),
      );
    for (const definition of ADMIN_REPORT_METRICS)
      if (!metrics.some((metric) => metric.key === definition.key))
        metrics.push(
          reportMetric(definition.key, null, source, null, {
            reason:
              [
                "credits",
                "invoiced",
                "paid",
                "refunds",
                "outstanding",
              ].includes(definition.key)
                ? "Central billing owns this metric"
                : definition.key === "payment_failures" ||
                    definition.key === "subscriptions"
                  ? "Central billing owns this metric"
                  : definition.key === "operations"
                    ? "Usage is forwarded to central billing; Growth no longer keeps a local usage ledger"
                    : definition.key === "active_users"
                      ? "Usage records do not establish human actor identity"
                      : "Not authoritative in this source",
          }),
        );
    for (const metric of metrics)
      if (metric.value !== null && Object.hasOwn(growthDetailDefinitions, metric.key))
        metric.detailSupported = true;
    const records = q.detail
      ? await growthMetricRecords(db, q)
      : q.view === "customers"
        ? (
            await db.query(
              `SELECT id,name,"createdAt" FROM "Organization"
                WHERE ($1::text IS NULL OR id=$1)
                  AND ($4::text IS NULL OR id=$4 OR strpos(lower(name),lower($4))>0)
                ORDER BY "createdAt" DESC,id LIMIT $2 OFFSET $3`,
              [
                q.organizationId ?? null,
                q.pageSize + 1,
                (q.page - 1) * q.pageSize,
                q.customerSearch || null,
              ],
            )
          ).rows.map((row) => ({
            id: row.id,
            orgId: row.id,
            status: "current",
            issuedAt: row.createdAt,
            label: row.name,
            kind: "organization",
          }))
        : [];
    return {
      contractVersion: "1",
      product: "growth",
      query: q,
      generatedAt: new Date().toISOString(),
      sourceObservedAt: metrics.reduce<string | null>(
        (last, metric) =>
          metric.observedAt && (!last || metric.observedAt > last)
            ? metric.observedAt
            : last,
        null,
      ),
      completeThrough: null,
      availability: "partial",
      metrics,
      records: records.slice(0, q.pageSize).map((row) => ({
        id: row.id,
        organizationId: row.orgId,
        kind: row.kind ?? "organization",
        ...(row.label ? { label: row.label } : {}),
        state: row.status,
        occurredAt: row.issuedAt.toISOString(),
      })),
      hasMore: records.length > q.pageSize,
    };
  });
}
