import { createHash } from "node:crypto";
import type { Integer, Timestamp } from "@kasitek/contracts";
// Object members sort lexically as serde_json's BTreeMap does. Integer values never pass through Number.
export class SerdeFloat {
  readonly __serde_float = true as const;
  constructor(public readonly value: number) {
    if (!Number.isFinite(value)) throw new Error("JSON number must be finite");
  }
}
export const serdeFloat = (value: number): SerdeFloat => new SerdeFloat(value);
// Ryu serde_json formatting uses scientific notation outside [1e-5, 1e16).
function floatToken(value: number): string {
  if (Object.is(value, -0)) return "-0.0";
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude < 1e-5 || magnitude >= 1e16))
    return value.toExponential();
  const token = String(value);
  return Number.isInteger(value) ? token + ".0" : token;
}
export function canonicalJson(value: unknown): string {
  if (value instanceof SerdeFloat) return floatToken(value.value);
  if (value === null) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JSON number must be finite");
    if (!Number.isInteger(value) || Object.is(value, -0))
      return floatToken(value);
    if (!Number.isSafeInteger(value))
      throw new Error(
        "unsafe JSON integer; use bigint or serdeFloat explicitly",
      );
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return (
      "{" +
      Object.keys(value)
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  throw new Error("unsupported JSON value");
}
export const canonicalJsonSha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");
export function integer(value: Integer): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new Error("unsafe integer; use bigint or a decimal string");
  if (typeof value === "string" && !/^-?\d+$/.test(value))
    throw new Error("invalid integer");
  return BigInt(value);
}
export function wireInteger(value: Integer): number | bigint {
  const v = integer(value);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) &&
    v >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(v)
    : v;
}
export function timestamp(value: Timestamp): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("invalid time");
    return value.toISOString().replace(".000Z", "Z");
  }
  if (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  ) {
    if (new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19))
      throw new Error("invalid time");
    return value;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid time");
  return date.toISOString().replace(".000Z", "Z");
}
export function parseLosslessJson(value: string): unknown {
  const parse = JSON.parse as unknown as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string },
    ) => unknown,
  ) => unknown;
  return parse(value, (_key, current, context) =>
    typeof current === "number" &&
    context?.source &&
    /^-?\d+$/.test(context.source) &&
    !Number.isSafeInteger(current)
      ? BigInt(context.source)
      : current,
  );
}

export function parseCanonicalJson(value: string): unknown {
  const parse = JSON.parse as unknown as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string },
    ) => unknown,
  ) => unknown;
  return parse(value, (_key, current, context) =>
    typeof current === "number" && context?.source
      ? /^-?\d+$/.test(context.source)
        ? Number.isSafeInteger(current)
          ? current === 0
            ? 0
            : current
          : BigInt(context.source)
        : serdeFloat(current)
      : current,
  );
}
