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

type UnicodeEscapeIssue = { detail: string; offset: number };

class SerdeJsonSyntaxError extends SyntaxError {
  constructor(
    readonly detail: string,
    readonly offset: number,
  ) {
    super(detail);
  }
}

type JsonSchema = Record<string, unknown>;

function schemaBranches(schemas: readonly unknown[]): JsonSchema[] {
  const result: JsonSchema[] = [];
  const visited = new Set<unknown>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    const schema = value as JsonSchema;
    result.push(schema);
    for (const keyword of ["allOf", "anyOf", "oneOf"]) {
      const branches = schema[keyword];
      if (Array.isArray(branches)) for (const branch of branches) visit(branch);
    }
  };
  for (const schema of schemas) visit(schema);
  return result;
}

function objectValueSchemas(
  schemas: readonly unknown[],
  key: string,
): { declared: unknown[]; value: unknown[] } {
  const declared: unknown[] = [];
  const additional: unknown[] = [];
  for (const schema of schemaBranches(schemas)) {
    const properties = schema.properties;
    if (
      properties &&
      typeof properties === "object" &&
      Object.hasOwn(properties, key)
    ) {
      declared.push((properties as Record<string, unknown>)[key]);
      continue;
    }
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    )
      additional.push(schema.additionalProperties);
  }
  return { declared, value: declared.length ? declared : additional };
}

function itemValueSchemas(schemas: readonly unknown[]): unknown[] {
  return schemaBranches(schemas)
    .map((schema) => schema.items)
    .filter((item) => item !== undefined);
}

/**
 * Preserve Serde's duplicate-field check for schema-declared struct members.
 * Unknown and additional-property map keys remain last-value-wins, as they do
 * at a serde_json::Value/HashMap boundary.
 */
export function assertNoDuplicateSerdeStructFields(
  source: string,
  schema: unknown,
): void {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(source[index] ?? "")) index++;
  };
  const string = (): { value: string; end: number } => {
    const start = index++;
    while (index < source.length) {
      const char = source[index++]!;
      if (char === "\\") index++;
      else if (char === '"') {
        const value: unknown = JSON.parse(source.slice(start, index));
        if (typeof value !== "string") throw new SyntaxError("Invalid JSON key");
        return { value, end: index };
      }
    }
    throw new SyntaxError("Invalid JSON string");
  };
  const value = (schemas: readonly unknown[]): void => {
    whitespace();
    const token = source[index];
    if (token === "{") {
      index++;
      whitespace();
      if (source[index] === "}") {
        index++;
        return;
      }
      const seen = new Set<string>();
      while (index < source.length) {
        whitespace();
        const property = string();
        const child = objectValueSchemas(schemas, property.value);
        if (child.declared.length) {
          if (seen.has(property.value))
            throw new SerdeJsonSyntaxError(
              `duplicate field \`${property.value}\``,
              property.end,
            );
          seen.add(property.value);
        }
        whitespace();
        index++; // colon; syntax was already checked by the JSON parser
        value(child.value);
        whitespace();
        if (source[index] === "}") {
          index++;
          return;
        }
        index++; // comma
      }
      throw new SyntaxError("Invalid JSON object");
    }
    if (token === "[") {
      index++;
      whitespace();
      if (source[index] === "]") {
        index++;
        return;
      }
      const items = itemValueSchemas(schemas);
      while (index < source.length) {
        value(items);
        whitespace();
        if (source[index] === "]") {
          index++;
          return;
        }
        index++; // comma
      }
      throw new SyntaxError("Invalid JSON array");
    }
    if (token === '"') {
      string();
      return;
    }
    while (
      index < source.length &&
      !/[\s,\]}]/.test(source[index]!)
    )
      index++;
  };
  value([schema]);
}

function invalidSurrogateEscape(source: string): UnicodeEscapeIssue | undefined {
  let inString = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (!inString) {
      if (char === '"') inString = true;
      continue;
    }
    if (char === '"') {
      inString = false;
      continue;
    }
    if (char !== "\\") continue;

    if (source[index + 1] !== "u") {
      index++;
      continue;
    }
    const firstHex = source.slice(index + 2, index + 6);
    if (!/^[\da-f]{4}$/i.test(firstHex)) {
      index++;
      continue;
    }
    const first = Number.parseInt(firstHex, 16);
    const firstEnd = index + 6;
    if (first >= 0xdc00 && first <= 0xdfff)
      return {
        detail: "lone leading surrogate in hex escape",
        offset: firstEnd,
      };
    if (first < 0xd800 || first > 0xdbff) {
      index = firstEnd - 1;
      continue;
    }

    if (source[firstEnd] !== "\\") {
      const next = source.codePointAt(firstEnd);
      const consumed = next === undefined ? 0 : next > 0xffff ? 2 : 1;
      return {
        detail: "unexpected end of hex escape",
        offset: firstEnd + consumed,
      };
    }
    if (source[firstEnd + 1] !== "u") {
      return {
        detail: "unexpected end of hex escape",
        offset: Math.min(source.length, firstEnd + 2),
      };
    }
    const secondHex = source.slice(firstEnd + 2, firstEnd + 6);
    if (!/^[\da-f]{4}$/i.test(secondHex)) {
      index = firstEnd;
      continue;
    }
    const second = Number.parseInt(secondHex, 16);
    const secondEnd = firstEnd + 6;
    if (second < 0xdc00 || second > 0xdfff)
      return {
        detail: "lone leading surrogate in hex escape",
        offset: secondEnd,
      };
    index = secondEnd - 1;
  }
}

/** Call after JSON syntax parsing to enforce serde_json's UTF-8 string rules. */
export function assertSerdeUnicodeEscapes(source: string): void {
  const issue = invalidSurrogateEscape(source);
  if (issue) throw new SerdeJsonSyntaxError(issue.detail, issue.offset);
}

function enclosingContainer(source: string, end: number): "{" | "[" | undefined {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;
  for (const char of source.slice(0, end)) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") stack.push(char);
    else if (char === "}" && stack.at(-1) === "{") stack.pop();
    else if (char === "[") stack.push(char);
    else if (char === "]" && stack.at(-1) === "[") stack.pop();
  }
  return stack.at(-1);
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
  if (error instanceof SerdeJsonSyntaxError)
    return `${error.detail} ${syntaxLocation(source, error.offset, true)}`;
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
  const container = enclosingContainer(source, offset);
  const trailingComma =
    before.endsWith(",") &&
    ((container === "{" && after.startsWith("}")) ||
      (container === "[" && after.startsWith("]")));

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

type ValidationIssue = {
  instancePath?: string;
  keyword?: string;
  message?: string;
  params?: unknown;
};

function pointerParts(instancePath: string | undefined): string[] {
  if (!instancePath) return [];
  return instancePath
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function actualType(value: unknown): string {
  if (value === undefined) return "a missing value";
  if (value === null) return "null";
  if (Array.isArray(value)) return "a sequence";
  if (typeof value === "string") return "a string";
  if (typeof value === "boolean") return "a boolean";
  if (typeof value === "bigint") return "an integer";
  if (typeof value === "number")
    return Number.isInteger(value) ? "an integer" : "a number";
  return "a map";
}

function expectedType(value: unknown): string {
  const labels: Record<string, string> = {
    array: "a sequence",
    boolean: "a boolean",
    integer: "an integer",
    null: "null",
    number: "a number",
    object: "a map",
    string: "a string",
  };
  if (Array.isArray(value))
    return value
      .map((item) => labels[String(item)] ?? String(item))
      .join(" or ");
  return labels[String(value)] ?? "a valid value";
}

/** Format schema-validation diagnostics without reflecting submitted values. */
export function formatSerdeValidationError(
  issues: readonly ValidationIssue[],
  context: string | undefined,
  root: unknown,
): string {
  const issue = issues[0];
  if (!issue) return "Invalid request";

  const parts = pointerParts(issue.instancePath);
  const locationRoot = context === "querystring" ? "query" : context ?? "request";
  const location = parts.length
    ? ` at \`${locationRoot}.${parts.join(".")}\``
    : "";
  const params =
    issue.params && typeof issue.params === "object"
      ? (issue.params as Record<string, unknown>)
      : undefined;
  if (
    issue.keyword === "required" &&
    typeof params?.missingProperty === "string"
  )
    return `missing field \`${params.missingProperty}\`${location}`;
  if (
    issue.keyword === "additionalProperties" &&
    typeof params?.additionalProperty === "string"
  )
    return `unknown field \`${params.additionalProperty}\`${location}`;
  if (issue.keyword === "type")
    return `invalid type: ${actualType(valueAtPath(root, parts))}, expected ${expectedType(params?.type)}${location}`;
  if (issue.keyword === "enum")
    return `invalid value${location}; ${issue.message ?? "value is not allowed"}`;
  return `${issue.message ?? "invalid value"}${location}`;
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
  // serde serializes Vec<u8> as a JSON array; Buffer's default toJSON shape is different.
  if (value instanceof Uint8Array)
    return "[" + Array.from(value, (byte) => String(byte)).join(",") + "]";
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

function prepareApiJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString().replace(".000Z", "Z");
  if (value instanceof SerdeFloat) return value;
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : prepareApiJson(item)));
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, prepareApiJson(item)]),
    );
  }
  return value;
}

/** JSON serializer shared by service HTTP replies: dates and i64 values stay precise. */
export function apiJson(value: unknown): string {
  return canonicalJson(prepareApiJson(value));
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

type JsonReviver = (
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

function parseJsonWithReviver(value: string, reviver: JsonReviver): unknown {
  const parse = JSON.parse as unknown as (
    text: string,
    reviver: JsonReviver,
  ) => unknown;
  const result = parse(value, reviver);
  assertSerdeUnicodeEscapes(value);
  return result;
}

export function parseLosslessJson(value: string): unknown {
  return parseJsonWithReviver(value, (_key, current, context) =>
    typeof current === "number" &&
    context?.source &&
    /^-?\d+$/.test(context.source) &&
    !Number.isSafeInteger(current)
      ? BigInt(context.source)
      : current,
  );
}

export function parseCanonicalJson(value: string): unknown {
  return parseJsonWithReviver(value, (_key, current, context) =>
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
  return parseJsonWithReviver(text, (_key, value, context) => {
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
