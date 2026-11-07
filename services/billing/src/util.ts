export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code = "request_failed",
  ) {
    super(message);
  }
}

export function bad(message = "Check request fields"): never {
  throw new HttpError(400, message, "bad_request");
}

export function missing(message = "Not found"): never {
  throw new HttpError(404, message, "not_found");
}

export function conflict(message = "State conflict"): never {
  throw new HttpError(409, message, "conflict");
}

export function unauthorized(message = "Unauthorized"): never {
  throw new HttpError(401, message, "unauthorized");
}

export function text(value: unknown, name: string, max = 2000): string {
  if (typeof value !== "string") return bad(`${name} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) bad(`${name} is invalid`);
  return normalized;
}

export function optionalText(value: unknown, max = 2000): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") bad("Expected text");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max) bad("Text is too long");
  return normalized;
}

export function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") bad("Expected boolean");
  return value;
}

export function integerValue(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    bad(`${name} is invalid`);
  return parsed;
}

export function bigValue(
  value: unknown,
  name: string,
  min = 0n,
  max = 9_223_372_036_854_775_807n,
): bigint {
  if (
    typeof value !== "bigint" &&
    typeof value !== "number" &&
    typeof value !== "string"
  )
    return bad(`${name} is required`);
  let parsed: bigint;
  try {
    parsed = BigInt(String(value));
  } catch {
    return bad(`${name} is invalid`);
  }
  if (parsed < min || parsed > max) bad(`${name} is out of range`);
  return parsed;
}

export function wire(value: bigint | number | string | null | undefined): string {
  if (value === null || value === undefined) return "0";
  return String(value);
}

export function optionalWire(
  value: bigint | number | string | null | undefined,
): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function dateValue(value: unknown, name: string): Date {
  if (typeof value !== "string" && !(value instanceof Date))
    bad(`${name} is required`);
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) bad(`${name} is invalid`);
  return parsed;
}

export function objectValue(
  value: unknown,
  name = "body",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    bad(`${name} must be an object`);
  return value as Record<string, unknown>;
}

export function arrayValue(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) bad(`${name} must be an array`);
  return value;
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function slug(value: unknown, name: string): string {
  const result = text(value, name, 80).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(result))
    bad(`${name} must use lowercase letters, numbers, dots, hyphens, or underscores`);
  return result;
}

export function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("Invalid denominator");
  return (numerator + denominator / 2n) / denominator;
}
