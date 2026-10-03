import { createHash } from "node:crypto";
import type { Integer, Timestamp } from "@kasitek-labs/contracts";

function syntaxOffset(source: string, message: string): number {
  const position = /\bposition\s+(\d+)/.exec(message);
  if (position) return Number(position[1]);
  const token = /Unexpected token '((?:\\.|[^'])*)'/.exec(message)?.[1];
  if (token) {
    const character = token.replace(/\\(.)/g, "$1");
    const punctuation = [",", "]", "}"].includes(character);
    const offset = punctuation
      ? source.lastIndexOf(character)
      : source.indexOf(character);
    if (offset >= 0) return offset;
  }
  return source.length;
}

function syntaxLocation(source: string, offset: number, atEnd: boolean): string {
  const bounded = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, bounded);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const lineStart = before.lastIndexOf("\n") + 1;
  const column =
    Buffer.byteLength(before.slice(lineStart), "utf8") + (atEnd ? 0 : 1);
  return `at line ${line} column ${column}`;
}

type JsonSyntaxKind = "a value" | "an object" | "a list" | "a string";

function eofSyntaxKind(source: string): JsonSyntaxKind {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  if (inString) return "a string";
  const last = source.trimEnd().at(-1);
  const container = stack.at(-1);
  if (container === "{" && last !== ":" && last !== ",") return "an object";
  if (container === "[" && last !== ",") return "a list";
  return "a value";
}

/** Format Node JSON.parse syntax errors without reflecting submitted values. */
export function formatSerdeJsonSyntaxError(
  source: string,
  error: unknown,
): string {
  if (!(error instanceof SyntaxError)) return "Invalid JSON";
  const message = error.message;
  const offset = syntaxOffset(source, message);
  const atEnd =
    offset >= source.length ||
    /Unexpected end of JSON input|Unterminated string|Unterminated fractional number|Exponent part is missing/.test(
      message,
    );
  const location = syntaxLocation(source, offset, atEnd);
  const before = source.slice(0, offset).trimEnd();
  const after = source.slice(offset).trimStart();
  const trailingComma =
    before.endsWith(",") && (after.startsWith("}") || after.startsWith("]"));

  if (trailingComma) return `trailing comma ${location}`;
  if (/Unexpected non-whitespace character after JSON/.test(message))
    return `trailing characters ${location}`;
  if (/Unexpected number in JSON/.test(message))
    return `invalid number ${location}`;
  if (/Bad escaped character|Bad Unicode escape/.test(message))
    return `invalid escape ${location}`;
  if (/Bad control character in string literal/.test(message))
    return `control character (\\u0000-\\u001F) found while parsing a string ${location}`;
  if (atEnd)
    return `EOF while parsing ${eofSyntaxKind(source)} ${location}`;
  if (/Expected ':' after property name/.test(message))
    return `expected \`:\` ${location}`;
  if (/Expected ',' or ']' after array element/.test(message))
    return `expected \`,\` or \`]\` ${location}`;
  if (/Expected ',' or '}' after property value/.test(message))
    return `expected \`,\` or \`}\` ${location}`;
  if (/Expected property name|Expected double-quoted property name/.test(message))
    return `key must be a string ${location}`;

  if (/Unexpected token/.test(message)) {
    const tokenStart = offset - 1;
    let start = tokenStart;
    while (start >= 0 && /[A-Za-z]/.test(source[start]!)) start--;
    const token = source.slice(start + 1, offset + 1);
    const detail = /^[ntf]/.test(token) ? "expected ident" : "expected value";
    return `${detail} ${location}`;
  }
  return `expected value ${location}`;
}

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

/** serde_json::Value keeps only i64/u64 integer tokens; every other numeric token is f64. */
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
    if (/^-?\d+$/.test(token) && token !== "-0") {
      const parsed = BigInt(token);
      if (parsed >= -(1n << 63n) && parsed <= (1n << 64n) - 1n)
        return Number.isSafeInteger(value) ? value : parsed;
    }
    return serdeFloat(value);
  });
}
