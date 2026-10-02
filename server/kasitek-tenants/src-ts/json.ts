import { canonicalJson, SerdeFloat } from "@kasitek/server-support/json";

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

/** serde_json::Value stores integers only within i64/u64 and floating tokens retain their kind. */
export function parseSerdeValueJson(text: string): unknown {
  const parse = JSON.parse as unknown as (
    text: string,
    reviver: (
      key: string,
      value: unknown,
      context?: { source?: string },
    ) => unknown,
  ) => unknown;
  return parse(text, (_key, value, context) => {
    if (typeof value !== "number" || !context?.source) return value;
    const token = context.source;
    if (/^[-]?\d+$/.test(token) && token !== "-0") {
      const integer = BigInt(token);
      if (integer >= -(1n << 63n) && integer <= (1n << 64n) - 1n)
        return Number.isSafeInteger(value) ? value : integer;
    }
    return new SerdeFloat(value);
  });
}
