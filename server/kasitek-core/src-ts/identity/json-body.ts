import {
  RUST_JSON_NUMERIC_FIELDS,
  RUST_JSON_VALUE_ROUTES,
  RUST_JSON_VALUE_FIELDS,
} from "./json-number-contracts.js";
import { parseSerdeValueJson } from "../json.js";
import type { FastifyRequest } from "fastify";
import { parseLosslessJson, SerdeFloat } from "@kasitek-labs/server-support/json";
import { RequestExtractionError } from "../error.js";
const canonicalBodies = new WeakMap<FastifyRequest, unknown>();
/** Preserve JSON number kinds separately while typed DTOs keep primitive numbers for Ajv. */
export function parseRequestJson(
  request: FastifyRequest,
  text: string,
): unknown {
  const typed = parseLosslessJson(text);
  canonicalBodies.set(request, parseSerdeValueJson(text));
  return typed;
}
/** Use at an actual serde_json::Value boundary, after the ordinary JSON parser ran. */
export function canonicalJsonBody(request: FastifyRequest): unknown {
  return canonicalBodies.has(request)
    ? canonicalBodies.get(request)
    : request.body;
}
export function jsonValueAt(
  request: FastifyRequest,
  path: readonly (string | number)[],
): unknown {
  let value = canonicalJsonBody(request);
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
export function jsonNumberKind(
  request: FastifyRequest,
  path: readonly (string | number)[],
): "integer" | "float" | null {
  const value = jsonValueAt(request, path);
  return value instanceof SerdeFloat
    ? "float"
    : typeof value === "number" || typeof value === "bigint"
      ? "integer"
      : null;
}
export function requireJsonIntegerToken(
  request: FastifyRequest,
  path: readonly (string | number)[],
  message = "Invalid request",
): void {
  if (jsonNumberKind(request, path) === "float")
    throw new RequestExtractionError("json", message);
}
/** JSON Schema integer describes a Rust integer token, including integral exponent/decimal rejection. */
export function validateIntegerTokenSchema(
  request: FastifyRequest,
  schema: unknown,
): void {
  function walk(rule: unknown, value: unknown) {
    if (!rule || typeof rule !== "object") return;
    const object = rule as Record<string, unknown>;
    const types = Array.isArray(object.type) ? object.type : [object.type];
    if (
      types.includes("integer") &&
      !types.includes("number") &&
      value instanceof SerdeFloat
    )
      throw new RequestExtractionError("json");
    if (
      value === null ||
      typeof value !== "object" ||
      value instanceof SerdeFloat
    )
      return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(object.items, entry);
      return;
    }
    const properties = object.properties as Record<string, unknown> | undefined;
    for (const [key, entry] of Object.entries(value))
      walk(properties?.[key] ?? object.additionalProperties, entry);
    for (const branch of Array.isArray(object.allOf) ? object.allOf : [])
      walk(branch, value);
  }
  walk(schema, canonicalJsonBody(request));
}

/** Typed f64 fields accept JSON integer tokens too; convert bigint only where a numeric DTO schema says number. */
export function normalizeTypedNumberSchema(
  request: FastifyRequest,
  schema: unknown,
): void {
  function convert(rule: unknown, value: unknown): unknown {
    if (!rule || typeof rule !== "object") return value;
    const object = rule as Record<string, unknown>;
    const types = Array.isArray(object.type) ? object.type : [object.type];
    if (types.includes("number") && typeof value === "bigint")
      return Number(value);
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++)
        value[index] = convert(object.items, value[index]);
      return value;
    }
    const properties = object.properties as Record<string, unknown> | undefined;
    for (const key of Object.keys(value)) {
      const body = value as Record<string, unknown>;
      body[key] = convert(
        properties?.[key] ?? object.additionalProperties,
        body[key],
      );
    }
    return value;
  }
  request.body = convert(schema, request.body);
}

/** Apply the actual Rust DTO integer/f64 token contract even to handlers with manual DTO validation. */
export function normalizeRustNumericContract(request: FastifyRequest): void {
  const fields =
    RUST_JSON_NUMERIC_FIELDS[request.method + " " + request.routeOptions.url] ??
    [];
  function visit(
    path: readonly string[],
    type: string,
    typed: unknown,
    canonical: unknown,
    parent: Record<string | number, unknown> | unknown[] | null,
    key: string | number | null,
  ): void {
    if (path.length) {
      const [head, ...tail] = path;
      if (head === "*") {
        if (Array.isArray(typed))
          for (let index = 0; index < typed.length; index++)
            visit(
              tail,
              type,
              typed[index],
              Array.isArray(canonical) ? canonical[index] : undefined,
              typed,
              index,
            );
      } else if (typed && typeof typed === "object") {
        visit(
          tail,
          type,
          (typed as Record<string, unknown>)[head!],
          canonical && typeof canonical === "object"
            ? (canonical as Record<string, unknown>)[head!]
            : undefined,
          typed as Record<string, unknown>,
          head!,
        );
      }
      return;
    }
    if (typed === null || typed === undefined) return;
    let value = typed;
    if (type.startsWith("f")) {
      if (typeof value === "bigint") value = Number(value);
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new RequestExtractionError("json");
      if (parent !== null && key !== null)
        (parent as Record<string | number, unknown>)[key] = value;
      return;
    }
    if (
      canonical instanceof SerdeFloat ||
      !(
        typeof value === "bigint" ||
        (typeof value === "number" && Number.isSafeInteger(value))
      )
    )
      throw new RequestExtractionError("json");
    const bits = Number(type.slice(1));
    const integer = BigInt(value);
    const min = type.startsWith("i") ? -(1n << BigInt(bits - 1)) : 0n,
      max = (1n << BigInt(type.startsWith("i") ? bits - 1 : bits)) - 1n;
    if (integer < min || integer > max)
      throw new RequestExtractionError("json");
  }
  for (const [path, type] of fields)
    visit(path, type, request.body, canonicalJsonBody(request), null, null);
}

export function isSerdeValueBodyBoundary(request: FastifyRequest): boolean {
  return RUST_JSON_VALUE_ROUTES.has(
    request.method + " " + request.routeOptions.url,
  );
}
export function normalizeSerdeValueBodyBoundary(request: FastifyRequest): void {
  if (isSerdeValueBodyBoundary(request) && canonicalBodies.has(request))
    request.body = canonicalJsonBody(request);
}

/** Restore only fields declared Value in a Rust DTO, including array element metadata. */
export function normalizeRustValueFields(request: FastifyRequest): void {
  const paths =
    RUST_JSON_VALUE_FIELDS[request.method + " " + request.routeOptions.url] ??
    [];
  function project(
    path: readonly string[],
    typed: unknown,
    canonical: unknown,
  ): void {
    if (
      !typed ||
      typeof typed !== "object" ||
      !canonical ||
      typeof canonical !== "object"
    )
      return;
    const [head, ...tail] = path;
    if (head === "*") {
      if (Array.isArray(typed) && Array.isArray(canonical)) {
        for (let index = 0; index < typed.length; index++)
          project(tail, typed[index], canonical[index]);
      }
      return;
    }
    if (head === undefined) return;
    const dto = typed as Record<string, unknown>,
      value = canonical as Record<string, unknown>;
    if (!Object.hasOwn(dto, head) || !Object.hasOwn(value, head)) return;
    if (tail.length) project(tail, dto[head], value[head]);
    else dto[head] = value[head];
  }
  for (const path of paths)
    project(path, request.body, canonicalJsonBody(request));
}
