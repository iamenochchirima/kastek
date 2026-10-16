import { createId } from "@paralleldrive/cuid2";
import type { Pool } from "pg";
import { stringify } from "csv-stringify/sync";
import { canonicalJson, SerdeFloat } from "@kasitek-labs/server-support/json";
import { ApiError } from "../../error.js";
import type { AdminUser } from "../../identity/admin-session.js";
import { reportWindow, type Row } from "./analytics.js";
import * as sql from "./reports-sql.js";
import { REPORT_DEFINITIONS } from "./report-definitions.js";
export { REPORT_DEFINITIONS };
const bad = (message: string) => new ApiError(400, "bad_request", message);
const known = (key: string) =>
  REPORT_DEFINITIONS.some((report) => report.key === key);
const version = (key: string) =>
  REPORT_DEFINITIONS.find((report) => report.key === key)?.version ?? 0;
function saved(row: Row, adminName?: string): Row {
  const stored = row.config?.version;
  let effective = version(row.reportKey);
  if (
    !(stored instanceof SerdeFloat) &&
    (typeof stored === "bigint" ||
      (typeof stored === "number" && Number.isSafeInteger(stored))) &&
    stored >= 0 &&
    BigInt(stored) <= 18446744073709551615n
  )
    effective = Number(BigInt(stored) % 256n) as typeof effective;
  return {
    id: row.id,
    name: row.name,
    reportKey: row.reportKey,
    config: row.config,
    version: effective,
    createdById: row.createdById,
    createdByName: adminName ?? row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
export async function listReports(pool: Pool, adminId: string): Promise<Row> {
  return {
    reports: REPORT_DEFINITIONS,
    saved: (
      await pool.query(sql.LOAD_SAVED_REPORTS_0, [adminId, 100])
    ).rows.map((row) => saved(row)),
  };
}
export interface SaveReportInput {
  name: string;
  reportKey: string;
  days?: number | bigint | null;
  config?: unknown;
}
export async function saveReport(
  pool: Pool,
  admin: Pick<AdminUser, "id" | "name">,
  input: SaveReportInput,
): Promise<Row> {
  const name = input.name.trim();
  if (Array.from(name).length < 2 || Array.from(name).length > 80)
    throw bad("Report name must be between 2 and 80 characters");
  if (!known(input.reportKey)) throw bad("Report type is invalid");
  const days = input.days ?? 30;
  reportWindow(days);
  const base = input.config ?? {};
  if (
    typeof base !== "object" ||
    base instanceof SerdeFloat ||
    Array.isArray(base)
  )
    throw bad("Report configuration must be an object");
  const config = { ...base, days, version: version(input.reportKey) };
  let serialized: string;
  try {
    serialized = canonicalJson(config);
  } catch {
    throw bad("Report configuration is invalid");
  }
  if (Buffer.byteLength(serialized) > 8192)
    throw bad("Report configuration is too large");
  const row = (
    await pool.query(sql.SAVE_0, [
      createId(),
      name,
      input.reportKey,
      serialized,
      admin.id,
    ])
  ).rows[0];
  return saved(row, admin.name);
}
export async function removeReport(
  pool: Pool,
  adminId: string,
  id: string,
): Promise<void> {
  const result = await pool.query(sql.REMOVE_0, [id, adminId]);
  if (!result.rowCount)
    throw new ApiError(404, "not_found", "Saved report not found");
}
export async function exportReport(
  pool: Pool,
  adminId: string,
  key: string,
  days?: number | bigint | null,
): Promise<{ bytes: Buffer; filename: string }> {
  if (!known(key)) throw bad("Report type is invalid");
  const { start, end } = reportWindow(days),
    id = createId();
  await pool.query(sql.EXPORT_0, [id, adminId, key, days ?? 30]);
  const definition: Record<
    string,
    { query: string; headers: string[]; columns: string[] }
  > = {
    "platform-overview": {
      query: sql.WRITE_PLATFORM_OVERVIEW_0,
      headers: [
        "date",
        "new_organizations",
        "new_users",
        "active_organizations",
        "operations",
        "collected_revenue_minor",
      ],
      columns: [
        "date",
        "new_organizations",
        "new_users",
        "active_organizations",
        "operations",
        "collected_revenue_minor",
      ],
    },
    "usage-daily": {
      query: sql.WRITE_USAGE_DAILY_0,
      headers: [
        "date",
        "operations",
        "conversations",
        "messages",
        "calls",
        "campaign_sends",
        "credits_consumed",
      ],
      columns: [
        "date",
        "operations",
        "conversations",
        "messages",
        "calls",
        "campaign_sends",
        "credits_consumed",
      ],
    },
    "revenue-daily": {
      query: sql.WRITE_REVENUE_DAILY_0,
      headers: [
        "date",
        "collected_revenue_minor",
        "refunds_minor",
        "paid_invoices",
        "failed_checkouts",
      ],
      columns: [
        "date",
        "collected_revenue_minor",
        "refunds_minor",
        "paid_invoices",
        "failed_checkouts",
      ],
    },
    "customer-cohorts": {
      query: sql.WRITE_CUSTOMER_COHORTS_0,
      headers: [
        "organization_id",
        "organization_name",
        "current_plan",
        "operations",
        "active_days",
      ],
      columns: ["id", "name", "plan", "operations", "active_days"],
    },
  };
  let bytes: Buffer;
  try {
    const exportDefinition = definition[key]!,
      rows = (
        await pool.query(exportDefinition.query, [
          start.toISOString().replace(/Z$/, ""),
          end.toISOString().replace(/Z$/, ""),
        ])
      ).rows;
    bytes = Buffer.from(
      stringify(
        [
          exportDefinition.headers,
          ...rows.map((row) =>
            exportDefinition.columns.map((column) =>
              row[column] == null ? "" : String(row[column]),
            ),
          ),
        ],
        { record_delimiter: "\n" },
      ),
    );
  } catch (error) {
    await pool.query(sql.EXPORT_1, [id]).catch(() => {});
    throw error;
  }
  await pool.query(sql.EXPORT_2, [id]);
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return { bytes, filename: `kasitek-${key}-${stamp}.csv` };
}
