import { SerdeFloat } from "@kasitek/server-support/json";
import type { Pool, PoolClient } from "pg";
import { ApiError } from "../../error.js";
import { apiJson } from "../../json.js";
export type ObjectValue = Record<string, unknown>;
export const obj = (value: unknown): ObjectValue =>
  value &&
  typeof value === "object" &&
  !(value instanceof SerdeFloat) &&
  !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
export const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
export const present = (value: unknown) =>
  value !== null && value !== undefined;
export function requireString(body: ObjectValue, key: string): string {
  const value = str(body[key]);
  if (value === null) throw new ApiError(400, "bad_request", "Invalid request");
  return value;
}
export function bad(message: string): never {
  throw new ApiError(400, "bad_request", message);
}
export function missing(message: string): never {
  throw new ApiError(404, "not_found", message);
}
export function conflict(message: string): never {
  throw new ApiError(409, "conflict", message);
}
export function byteLength(value: string) {
  return Buffer.byteLength(value);
}
/** Reject calendar rollover that JavaScript Date accepts but chrono does not. */
export function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d\d)-(\d\d)/.exec(value);
  if (!match) return false;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return (
    day <=
    [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  );
}
export function parseDate(value: string): Date {
  const date = new Date(value);
  return /^\d{4}-\d\d-\d\d(?:T.*(?:Z|[+-]\d\d:\d\d))?$/.test(value) &&
    validCalendarDate(value) &&
    Number.isFinite(date.getTime())
    ? date
    : new Date();
}
export function nullableDate(value: string): Date | null {
  if (!value || value === "null") return null;
  const date = new Date(value);
  return /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    validCalendarDate(value) &&
    Number.isFinite(date.getTime())
    ? date
    : null;
}
export function parseValidityDays(value: unknown): number {
  if (
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    const number = BigInt(value);
    if (number < -(1n << 63n) || number >= 1n << 63n) return 14;
    return Number(BigInt.asIntN(32, number));
  }
  if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
    const n = BigInt(value);
    if (n >= -(1n << 31n) && n < 1n << 31n) return Number(n);
  }
  return 14;
}
export async function transaction<T>(
  pool: Pool,
  action: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await action(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
export async function updateFields(
  pool: Pool,
  table: string,
  id: string,
  columns: string,
  fields: [string, unknown][],
  notFound: string,
) {
  const updates = fields.filter(([, value]) => value !== undefined);
  if (!updates.length) {
    const row = (
      await pool.query(
        `SELECT ${columns} FROM "${table}" WHERE id=$1 LIMIT 1`,
        [id],
      )
    ).rows[0];
    return row ?? missing(notFound);
  }
  const args: unknown[] = [new Date()],
    sets = ['"updatedAt"=$1'];
  for (const [column, value] of updates) {
    args.push(value);
    sets.push(`"${column}"=$${args.length}`);
  }
  args.push(id);
  return (
    (
      await pool.query(
        `UPDATE "${table}" SET ${sets.join(",")} WHERE id=$${args.length} RETURNING ${columns}`,
        args,
      )
    ).rows[0] ?? missing(notFound)
  );
}
export const json = (value: unknown, fallback: unknown = []) =>
  apiJson(value ?? fallback);
