import type { Pool } from "pg";
import { ApiError } from "../../error.js";
import { UtcTimestamp } from "../../db.js";
import { apiJson } from "../../json.js";
import { setTimeout as sleep } from "node:timers/promises";
import { reportWindow, camel, type Row } from "./analytics.js";
import * as sql from "./activity-sql.js";
export interface ActivityQuery {
  days?: number | bigint | null;
  limit?: number | bigint | null;
  cursor?: string | null;
  domain?: string | null;
  action?: string | null;
  status?: string | null;
  severity?: string | null;
  organizationId?: string | null;
}
interface Cursor {
  occurredAt: Date;
  id: string;
}
export function encodeActivityCursor(date: Date, id: string): string {
  return Buffer.from(
    `${date.toISOString().replace(".000Z", "Z").replace("Z", "+00:00")}|${id}`,
  ).toString("base64");
}
export function decodeActivityCursor(
  value: string | null | undefined,
): Cursor | null {
  if (
    value == null ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return null;
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) return null;
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      separator = raw.lastIndexOf("|");
    if (separator < 0) return null;
    const timestamp = raw.slice(0, separator);
    if (
      !/^\d{4}-\d\d-\d\d[Tt]\d\d:\d\d:\d\d(?:\.\d+)?(?:[Zz]|[+-]\d\d:\d\d)$/.test(
        timestamp,
      )
    )
      return null;
    const date = new UtcTimestamp(timestamp.replace(/[zZ]$/, "+00:00"), true);
    return { occurredAt: date, id: raw.slice(separator + 1) };
  } catch {
    return null;
  }
}
export function validateActivityQuery(query: ActivityQuery): void {
  if (query.limit != null && (query.limit < 1 || query.limit > 100))
    throw new ApiError(
      400,
      "bad_request",
      "Activity limit must be between 1 and 100",
    );
  for (const key of [
    "domain",
    "action",
    "status",
    "severity",
    "organizationId",
  ] as const) {
    const value = query[key];
    if (value != null && (!value.trim() || Buffer.byteLength(value) > 160))
      throw new ApiError(
        400,
        "bad_request",
        `Activity ${key} filter is invalid`,
      );
  }
  if (query.cursor != null && !decodeActivityCursor(query.cursor))
    throw new ApiError(400, "bad_request", "Activity cursor is invalid");
}
export async function queryActivityRows(
  pool: Pool,
  query: ActivityQuery,
  start: Date,
  end: Date,
  cursor: Cursor | null,
  limit: number,
): Promise<Row[]> {
  return (
    await pool.query(sql.QUERY_ROWS_0, [
      start.toISOString().replace(/Z$/, ""),
      end.toISOString().replace(/Z$/, ""),
      cursor?.occurredAt.toISOString() ?? null,
      cursor?.id ?? null,
      query.domain ?? null,
      query.action ?? null,
      query.status ?? null,
      query.severity ?? null,
      query.organizationId ?? null,
      limit,
    ])
  ).rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [camel(key), value]),
    ),
  );
}
export async function listActivity(
  pool: Pool,
  query: ActivityQuery,
): Promise<Row> {
  validateActivityQuery(query);
  const w = reportWindow(query.days),
    limit = Number(query.limit ?? 40),
    rows = await queryActivityRows(
      pool,
      query,
      w.start,
      w.end,
      decodeActivityCursor(query.cursor),
      limit + 1,
    ),
    hasMore = rows.length > limit,
    items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    nextCursor: hasMore
      ? encodeActivityCursor(items.at(-1)!.occurredAt, items.at(-1)!.id)
      : null,
    hasMore,
    dataAsOf: new Date(),
    source: "core_authoritative",
    coverage:
      "Core immutable and transactional event records; projection-backed Agent Platform events are not included yet",
  };
}
export async function* streamActivity(
  pool: Pool,
  query: ActivityQuery,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const seen = new Set<string>(),
    order: string[] = [];
  while (!signal.aborted) {
    let window;
    try {
      window = reportWindow(query.days);
    } catch (error) {
      yield `event: error\ndata: ${apiJson({ error: displayError(error) })}\n\n`;
      return;
    }
    try {
      const items = await queryActivityRows(
        pool,
        query,
        window.start,
        window.end,
        null,
        Math.min(100, Number(query.limit ?? 40)),
      );
      for (const item of items.reverse()) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        order.push(item.id);
        if (order.length > 500) seen.delete(order.shift()!);
        yield `event: activity\ndata: ${apiJson(item)}\n\n`;
      }
      yield ": heartbeat\n\n";
    } catch (error) {
      yield `event: error\ndata: ${apiJson({ error: displayError(error) })}\n\n`;
    }
    await sleep(5000, undefined, { signal }).catch(() => {});
  }
}
function displayError(error: unknown): string {
  if (error instanceof ApiError)
    return `${error.status === 400 ? "Bad request" : "Internal error"}: ${error.message}`;
  return "Database error: database operation failed";
}
