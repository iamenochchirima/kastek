import {
  canonicalJson,
  canonicalJsonSha256,
  integer,
} from "@kasitek-labs/server-support/json";
export type RecordCategory =
  | "event"
  | "observation"
  | "scope_definition"
  | "manifest";
export interface RecordIdentity {
  producer_id: string;
  source_stream_key: string;
  record_category: RecordCategory;
  record_id: string;
  source_sequence: number | bigint;
  payload_hash: string;
}
export interface ScopeBinding {
  reporting_scope_id: bigint;
  root_scope_id: bigint;
}
export interface ObservationWindow {
  start: string;
  end: string;
}
export class RecordValidationError extends Error {}
export function validateSha256Hex(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value))
    throw new RecordValidationError(
      "payload hash must be lowercase SHA-256 hex",
    );
}
export function validateRecordIdentity(value: RecordIdentity): void {
  for (const field of [
    "producer_id",
    "source_stream_key",
    "record_id",
  ] as const)
    if (!value[field].trim())
      throw new RecordValidationError(`${field} must not be empty`);
  if (integer(value.source_sequence) > 9223372036854775807n)
    throw new RecordValidationError(
      "source sequence cannot exceed the signed 64-bit database range",
    );
  validateSha256Hex(value.payload_hash);
}
export function validateScopeBinding(value: ScopeBinding): void {
  for (const field of ["reporting_scope_id", "root_scope_id"] as const)
    if (value[field] <= 0n)
      throw new RecordValidationError(`${field} must be positive`);
}
export function canonicalJsonBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value));
}
export const canonicalPayloadSha256 = canonicalJsonSha256;
export function validatePayloadHash(value: unknown, expected: string): void {
  validateSha256Hex(expected);
  if (canonicalPayloadSha256(value) !== expected)
    throw new RecordValidationError(
      "payload hash does not match the canonical payload",
    );
}
/** Nanosecond ordering keeps Chrono boundaries independent of JS millisecond Date truncation. */
export function timestampNanos(value: string | Date): bigint {
  const text = (value instanceof Date ? value.toISOString() : value)
    .replace("t", "T")
    .replace(/z$/, "Z");
  const m =
    /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(
      text,
    );
  if (
    !m ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(text.slice(0, 10) + "T00:00:00Z").toISOString().slice(0, 10) !==
      text.slice(0, 10) ||
    Number(text.slice(11, 13)) > 23
  )
    throw new Error("invalid RFC3339 time");
  return (
    BigInt(Date.parse(m[1]! + m[3]!)) * 1000000n +
    BigInt((m[2] ?? "").padEnd(9, "0"))
  );
}
export function normalizedTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const ns = timestampNanos(value);
    const seconds = ns / 1000000000n,
      frac = ((ns % 1000000000n) + 1000000000n) % 1000000000n;
    const floor = ns < 0n && frac !== 0n ? seconds - 1n : seconds;
    return (
      new Date(Number(floor) * 1000).toISOString().slice(0, 19) +
      (frac !== 0n ? "." + chronoFraction(frac) : "") +
      "Z"
    );
  } catch {
    return null;
  }
}
export function addSeconds(value: string, seconds: bigint): string {
  const ns = timestampNanos(value) + seconds * 1000000000n;
  const floor = ns >= 0n ? ns / 1000000000n : (ns - 999999999n) / 1000000000n;
  const fraction = ns - floor * 1000000000n;
  return (
    new Date(Number(floor) * 1000).toISOString().slice(0, 19) +
    (fraction ? "." + chronoFraction(fraction) : "") +
    "Z"
  );
}
export function validateObservationWindow(value: ObservationWindow): void {
  if (timestampNanos(value.end) <= timestampNanos(value.start))
    throw new RecordValidationError(
      "observation window must end after it starts",
    );
}

function chronoFraction(value: bigint): string {
  const text = value.toString().padStart(9, "0");
  return text.endsWith("000000")
    ? text.slice(0, 3)
    : text.endsWith("000")
      ? text.slice(0, 6)
      : text;
}
