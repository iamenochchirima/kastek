import { canonicalJson, SerdeFloat } from "@kasitek-labs/server-support/json";

function prepare(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof SerdeFloat) return value;
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : prepare(item)));
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, prepare(item)]),
    );
  }
  return value;
}

/** i64 values remain numeric JSON tokens, and database dates retain their precision. */
export function apiJson(value: unknown): string {
  return canonicalJson(prepare(value));
}

export { parseSerdeValueJson } from "@kasitek-labs/server-support/json";
