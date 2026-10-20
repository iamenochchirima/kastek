import { isIP } from "node:net";
import { parseDocument } from "yaml";
import { PlatformError, canonicalJson, requestDigest } from "../../contracts/contracts";
import { publicAddress } from "../../infrastructure/connected-network";

export const OPENAPI_LIMITS = Object.freeze({ documentBytes: 524_288, documentNodes: 20_000, depth: 24,
  operations: 100, parameters: 50, resolvedNodes: 40_000, normalizedBytes: 2_097_152, requestBytes: 262_144, valueNodes: 4096, valueDepth: 16 });
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectValue = { [key: string]: Json };
export type OpenApiSchema = boolean | ObjectValue;
export type OpenApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "TRACE";
export interface OpenApiDiagnostic { code: string; message: string }
export interface OpenApiParameter {
  name: string; in: "path" | "query" | "header"; required: boolean;
  style: "form" | "simple"; explode: boolean; schema: OpenApiSchema;
}
export interface OpenApiSecurity {
  schemeId: string; type: "none" | "bearer" | "basic" | "api_key" | "oauth2";
  in?: "header" | "query"; name?: string; scopes: string[]; definition: ObjectValue;
}
export interface RequestTemplate {
  schemaVersion: 1; serverUrl: string; serverOrigin: string; method: OpenApiMethod; path: string;
  parameters: OpenApiParameter[]; requestBody: { required: boolean; contentType: "application/json"; schema: OpenApiSchema } | null;
  security: OpenApiSecurity; effect: "unknown"; reviewRequired: true; digest: string;
}
export interface OpenApiOperation {
  operationId: string | null; alias: string; method: OpenApiMethod; path: string; summary: string;
  parameters: OpenApiParameter[]; requestBody: RequestTemplate["requestBody"];
  responseSchemas: { status: string; contentType: string; schema: Json }[];
  securityRequirements: Json; serverCandidates: string[];
  security: OpenApiSecurity | null; effect: "unknown"; reviewRequired: true;
  securityChoices: { index: number; security: OpenApiSecurity | null; diagnostics: OpenApiDiagnostic[] }[];
  compatible: boolean; diagnostics: OpenApiDiagnostic[]; template: RequestTemplate | null;
}
export interface OpenApiImport {
  schemaVersion: 1; openapi: string; title: string; digest: string;
  server: { url: string; origin: string }; operations: OpenApiOperation[]; diagnostics: OpenApiDiagnostic[];
}
export interface OpenApiImportOptions { serverUrl: string; testLoopback?: boolean; securitySelections?: Readonly<Record<string, number>> }
export interface RequestArguments { path?: Record<string, unknown>; query?: Record<string, unknown>; headers?: Record<string, unknown>; body?: unknown }
export interface CredentialRequirement { schemeId: string; reference: string; type: Exclude<OpenApiSecurity["type"], "none">; in: "header" | "query"; name: string }
export interface CompiledOpenApiRequest {
  url: string; origin: string; method: OpenApiMethod; headers: Record<string, string>; body?: string;
  credentials: CredentialRequirement[]; templateDigest: string; effect: "unknown"; reviewRequired: true;
}
export type ResolvedOpenApiCredential = { type: "bearer" | "oauth2"; token: string }
  | { type: "basic"; username: string; password: string } | { type: "api_key"; value: string };

function fail(code: string, message: string): never { throw new PlatformError(code, 400, message); }
function object(value: unknown, message = "Expected an object"): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("OPENAPI_INVALID", message);
  return value as ObjectValue;
}
function text(value: unknown, maximum = 1024): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > maximum) fail("OPENAPI_INVALID", "Expected a bounded string");
  return value;
}
function array(value: Json | undefined): Json[] {
  if (!Array.isArray(value)) fail("OPENAPI_INVALID", "Expected an array");
  return value;
}
function boundedCopy(input: unknown, nodes: number = OPENAPI_LIMITS.documentNodes, depth: number = OPENAPI_LIMITS.depth): Json {
  let count = 0;
  const ancestors = new Set<object>();
  function copy(value: unknown, level: number): Json {
    if (++count > nodes || level > depth) fail("OPENAPI_LIMIT", "Document or input exceeds structural limits");
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value)
      || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("OPENAPI_INVALID", "Expected acyclic plain JSON");
    ancestors.add(value);
    let result: Json;
    if (Array.isArray(value)) result = value.map(child => copy(child, level + 1));
    else {
      const fields: ObjectValue = Object.create(null);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (["__proto__", "constructor", "prototype"].includes(key) || !descriptor.enumerable || !("value" in descriptor)) fail("OPENAPI_INVALID", "Unsafe object property");
        fields[key] = copy(descriptor.value, level + 1);
      }
      result = fields;
    }
    ancestors.delete(value);
    return result;
  }
  return copy(input, 0);
}
function load(source: unknown): ObjectValue {
  let raw = source;
  if (typeof source === "string") {
    if (Buffer.byteLength(source) > OPENAPI_LIMITS.documentBytes) fail("OPENAPI_LIMIT", "OpenAPI document exceeds byte limit");
    try {
      const document = parseDocument(source, { strict: true, uniqueKeys: true });
      if (document.errors.length) fail("OPENAPI_INVALID", "Invalid OpenAPI JSON or YAML");
      raw = document.toJS({ maxAliasCount: 0 });
    } catch { fail("OPENAPI_INVALID", "Invalid OpenAPI JSON or YAML"); }
  }
  const result = boundedCopy(raw);
  if (Buffer.byteLength(canonicalJson(result)) > OPENAPI_LIMITS.documentBytes) fail("OPENAPI_LIMIT", "OpenAPI document exceeds byte limit");
  return object(result);
}
const unsafeHeader = /^(?:authorization|proxy-authorization|cookie|set-cookie|host|connection|content-length|transfer-encoding|upgrade|trailer|te|expect|accept-encoding|content-type|forwarded|x-forwarded-.*|proxy-.*|sec-.*)$/i;
const authField = /^(?:authorization|proxy-authorization|api[-_]?key|x[-_]api[-_]key|access[-_]token|refresh[-_]token|client[-_]secret|password|credentials?)$/i;
function headerName(name: string, credential = false): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || unsafeHeader.test(name) && !(credential && name.toLowerCase() === "authorization")) fail("OPENAPI_HEADER_UNSUPPORTED", "Unsafe or reserved request header");
  return name.toLowerCase();
}
function safePath(value: string, template: boolean): string {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f?#%]/.test(value)
    || value.split("/").some(segment => segment === "." || segment === "..")
    || !template && /[{}]/.test(value)) fail("OPENAPI_PATH_UNSUPPORTED", "Expected a fixed absolute path without traversal or encoded delimiters");
  if (template && /[{}]/.test(value.replace(/\{[A-Za-z_][A-Za-z0-9_.-]*\}/g, ""))) fail("OPENAPI_PATH_UNSUPPORTED", "Invalid path parameter template");
  return value;
}
function server(value: string, loopback = false): URL {
  if (/[\\\x00-\x20\x7f{}]/.test(value)) fail("OPENAPI_SERVER_UNSUPPORTED", "Expected a fixed server URL");
  let url: URL;
  try { url = new URL(value); } catch { return fail("OPENAPI_SERVER_UNSUPPORTED", "Expected an absolute server URL"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const fixture = loopback && url.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(host);
  if (url.username || url.password || url.search || url.hash || !fixture && (url.protocol !== "https:" || url.port && url.port !== "443"
    || isIP(host) && !publicAddress(host) || !isIP(host) && (!host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)))) fail("OPENAPI_SERVER_UNSUPPORTED", "Select a public HTTPS server");
  // Inspect the original path too: URL parsing normalizes dot segments before returning pathname.
  const originalPath = value.replace(/^[A-Za-z]+:\/\/[^/]+/, "") || "/";
  safePath(originalPath, false);
  return url;
}

function resolver(root: ObjectValue) {
  let nodes = 0, bytes = 0;
  function resolve(value: Json, refs: string[] = [], depth = 0): Json {
    if (++nodes > OPENAPI_LIMITS.resolvedNodes || depth > OPENAPI_LIMITS.depth) fail("OPENAPI_LIMIT", "Resolved references exceed structural limits");
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    if (value && typeof value === "object" && !Array.isArray(value)) bytes += Object.keys(value).reduce((sum,key)=>sum+Buffer.byteLength(key),0);
    if(bytes>OPENAPI_LIMITS.normalizedBytes)fail("OPENAPI_LIMIT","Resolved references exceed byte limits");
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(child => resolve(child, refs, depth + 1));
    if (value.$ref !== undefined) {
      const ref = text(value.$ref);
      if (!ref.startsWith("#/") || /%(?![0-9A-Fa-f]{2})/.test(ref)) fail("OPENAPI_REF_UNSUPPORTED", "Only local JSON pointer references are supported");
      if (refs.includes(ref)) fail("OPENAPI_REF_RECURSIVE", "Recursive references are unsupported");
      if (Object.keys(value).some(key => !["$ref", "summary", "description"].includes(key))) fail("OPENAPI_REF_SIBLINGS_UNSUPPORTED", "Validation siblings of references are unsupported");
      let target: Json = root;
      for (const key of ref.slice(2).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
        if (["__proto__", "prototype", "constructor"].includes(key) || !target || typeof target !== "object" || Array.isArray(target) || !Object.hasOwn(target, key)) fail("OPENAPI_REF_UNRESOLVED", "Local reference cannot be resolved");
        target = target[key]!;
      }
      const result = resolve(target, [...refs, ref], depth + 1);
      if ((value.summary !== undefined || value.description !== undefined) && result && typeof result === "object" && !Array.isArray(result)) {
        return { ...result, ...(value.summary !== undefined ? { summary: value.summary } : {}), ...(value.description !== undefined ? { description: value.description } : {}) };
      }
      return result;
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child, refs, depth + 1)]));
  }
  return resolve;
}

const schemaAnnotations = new Set(["title", "description", "default", "example", "examples", "deprecated", "readOnly", "writeOnly"]);
const schemaKeywords = new Set(["type", "enum", "const", "properties", "required", "additionalProperties", "items", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "nullable", "format"]);
const types = ["null", "boolean", "object", "array", "number", "integer", "string"];
function schema(input: Json, version: string, allowAuthNames = false): OpenApiSchema {
  if (typeof input === "boolean") {
    if (version.startsWith("3.0")) fail("OPENAPI_SCHEMA_UNSUPPORTED", "OpenAPI 3.0 boolean schemas are unsupported");
    return input;
  }
  const value = object(input, "Expected a schema object");
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("x-") || schemaAnnotations.has(key)) continue;
    if (!schemaKeywords.has(key)) fail("OPENAPI_SCHEMA_UNSUPPORTED", `Unsupported schema keyword: ${key}`);
    if (key === "type") {
      const list = Array.isArray(child) ? child : [child];
      if (!list.length || list.some(type => typeof type !== "string" || !types.includes(type)) || new Set(list).size !== list.length
        || version.startsWith("3.0") && (Array.isArray(child) || child === "null")) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Unsupported schema type");
    } else if (key === "properties") {
      for (const [name, definition] of Object.entries(object(child))) {
        if (!allowAuthNames && authField.test(name)) fail("OPENAPI_AUTH_INPUT_UNSUPPORTED", "Authentication fields require trusted credential references");
        schema(definition, version, allowAuthNames);
      }
    } else if (key === "items" || key === "additionalProperties") schema(child, key === "additionalProperties" && typeof child === "boolean" ? "3.1" : version, allowAuthNames);
    else if (key === "required") {
      const required = array(child);
      if (required.some(name => typeof name !== "string") || new Set(required).size !== required.length) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Expected unique required property names");
      if (!allowAuthNames && required.some(name => typeof name === "string" && authField.test(name))) fail("OPENAPI_AUTH_INPUT_UNSUPPORTED", "Authentication fields require trusted credential references");
    } else if (key === "enum") {
      if (!Array.isArray(child) || !child.length || new Set(child.map(canonicalJson)).size !== child.length) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Expected a nonempty unique schema enum");
    } else if (["nullable", "uniqueItems"].includes(key)) {
      if (typeof child !== "boolean") fail("OPENAPI_SCHEMA_UNSUPPORTED", "Expected a boolean schema constraint");
      if (key === "nullable" && !version.startsWith("3.0")) fail("OPENAPI_SCHEMA_UNSUPPORTED", "OpenAPI 3.1 uses the null type instead of nullable");
    } else if (["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"].includes(key)) {
      if (typeof child !== "number" || !Number.isSafeInteger(child) || child < 0) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Expected a nonnegative schema bound");
    } else if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].includes(key)) {
      if (typeof child !== "number" && !(version.startsWith("3.0") && ["exclusiveMinimum", "exclusiveMaximum"].includes(key) && typeof child === "boolean")) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Expected a numeric schema bound");
      if (key === "multipleOf" && (typeof child !== "number" || child <= 0)) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Expected positive multipleOf");
    } else if (key === "format" && !["uuid", "date", "date-time", "int32", "int64", "float", "double"].includes(String(child))) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Unsupported schema format");
  }
  if (value.type === "array" && value.items === undefined) fail("OPENAPI_SCHEMA_UNSUPPORTED", "Array schemas require items");
  return value;
}
function validate(value: Json, definition: OpenApiSchema): void {
  const invalid = () => fail("OPENAPI_INPUT_INVALID", "Request input does not match its reviewed schema");
  if (definition === true) return;
  if (definition === false) invalid();
  const s = definition as ObjectValue;
  const matches = (type: Json) => type === "null" ? value === null : type === "array" ? Array.isArray(value)
    : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : type === "integer" ? typeof value === "number" && Number.isInteger(value) : typeof value === type;
  if (s.type !== undefined && !(value === null && s.nullable === true) && !(Array.isArray(s.type) ? s.type : [s.type]).some(matches)) invalid();
  if (s.enum !== undefined && !(s.enum as Json[]).some(item => canonicalJson(item) === canonicalJson(value))) invalid();
  if (s.const !== undefined && canonicalJson(s.const) !== canonicalJson(value)) invalid();
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && Array.from(value).length < s.minLength || typeof s.maxLength === "number" && Array.from(value).length > s.maxLength) invalid();
    if (s.format === "uuid" && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) invalid();
    if (s.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) invalid();
    if (s.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))) invalid();
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && (value < s.minimum || s.exclusiveMinimum === true && value === s.minimum)
      || typeof s.maximum === "number" && (value > s.maximum || s.exclusiveMaximum === true && value === s.maximum)
      || typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum || typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) invalid();
    if (typeof s.multipleOf === "number" && Math.abs(value / s.multipleOf - Math.round(value / s.multipleOf)) > 1e-10) invalid();
    if (s.format === "int32" && (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) || s.format === "int64" && !Number.isSafeInteger(value)) invalid();
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems || typeof s.maxItems === "number" && value.length > s.maxItems
      || s.uniqueItems === true && new Set(value.map(canonicalJson)).size !== value.length) invalid();
    if (s.items !== undefined) value.forEach(item => validate(item, s.items as OpenApiSchema));
  } else if (value && typeof value === "object") {
    const properties = s.properties ? object(s.properties) : {};
    if ((s.required as string[] | undefined)?.some(name => !Object.hasOwn(value, name))) invalid();
    if (typeof s.minProperties === "number" && Object.keys(value).length < s.minProperties || typeof s.maxProperties === "number" && Object.keys(value).length > s.maxProperties) invalid();
    for (const [name, child] of Object.entries(value)) {
      if (authField.test(name)) fail("OPENAPI_AUTH_INPUT_UNSUPPORTED", "Authentication fields require trusted credential references");
      if (Object.hasOwn(properties, name)) validate(child, properties[name] as OpenApiSchema);
      else if (s.additionalProperties === false) invalid();
      else if (s.additionalProperties && typeof s.additionalProperties === "object") validate(child, s.additionalProperties as OpenApiSchema);
    }
  }
}

function security(requirements: Json | undefined, schemes: ObjectValue, resolve: ReturnType<typeof resolver>): OpenApiSecurity {
  if (requirements === undefined || Array.isArray(requirements) && requirements.length === 0) return { schemeId: "none", type: "none", scopes: [], definition: {} };
  const alternatives = array(requirements);
  if (alternatives.length !== 1) fail("OPENAPI_SECURITY_ALTERNATIVES_UNSUPPORTED", "Select one security alternative before activation");
  const fields = Object.entries(object(alternatives[0]));
  if (!fields.length) return { schemeId: "none", type: "none", scopes: [], definition: {} };
  if (fields.length > 1) fail("OPENAPI_SECURITY_COMBINED_UNSUPPORTED", "Combined authentication methods are unsupported");
  const [schemeId, rawScopes] = fields[0]!, scopes = array(rawScopes).map(value => text(value, 256));
  if (!Object.hasOwn(schemes, schemeId)) fail("OPENAPI_SECURITY_UNKNOWN_SCHEME", "Security requirement references an unknown scheme");
  const definition = object(resolve(schemes[schemeId] ?? null)), type = definition.type;
  if (type !== "oauth2" && scopes.length) fail("OPENAPI_SECURITY_UNSUPPORTED", "Only OAuth schemes support named scopes");
  if (type === "http" && ["bearer", "basic"].includes(String(definition.scheme))) return { schemeId, type: definition.scheme as "bearer" | "basic", scopes, definition };
  if (type === "apiKey") {
    const location = definition.in;
    if (location !== "header" && location !== "query") fail("OPENAPI_SECURITY_UNSUPPORTED", "API keys support named headers or query parameters only");
    const name = text(definition.name, 128);
    if (location === "header") {
      headerName(name, true);
      if (name.toLowerCase() === "accept") fail("OPENAPI_SECURITY_UNSUPPORTED", "Credential header conflicts with response negotiation");
    }
    else if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) fail("OPENAPI_SECURITY_UNSUPPORTED", "Unsafe API key parameter name");
    return { schemeId, type: "api_key", in: location, name, scopes, definition };
  }
  if (type === "oauth2") {
    const flows = object(definition.flows), authorizationCode = object(flows.authorizationCode, "OAuth requires an authorization-code flow");
    for (const key of ["authorizationUrl", "tokenUrl"]) {
      const endpoint = new URL(text(authorizationCode[key]));
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) fail("OPENAPI_SECURITY_UNSUPPORTED", "OAuth metadata requires HTTPS URLs");
    }
    return { schemeId, type: "oauth2", scopes, definition };
  }
  return fail("OPENAPI_SECURITY_UNSUPPORTED", "Unsupported provider authentication method");
}

/** Import is offline preview. It establishes no network, credential, customer or effect authority. */
export function importOpenApiDocument(source: unknown, options: OpenApiImportOptions): OpenApiImport {
  if (Object.entries(options.securitySelections ?? {}).some(([alias, index]) => !/^api_[a-f0-9]{32}$/.test(alias) || !Number.isInteger(index) || index < 0 || index > 7)) fail("OPENAPI_SECURITY_SELECTION_INVALID", "Select one supported security alternative");
  const root = load(source), version = text(root.openapi, 16);
  if (!/^3\.(?:0|1)\.\d+$/.test(version)) fail("OPENAPI_VERSION_UNSUPPORTED", "Only OpenAPI 3.0 and 3.1 documents are supported");
  const selected = server(options.serverUrl, options.testLoopback), selectedUrl = selected.href.replace(/\/$/, ""), resolve = resolver(root);
  const paths = object(root.paths), schemes = root.components ? object(object(root.components).securitySchemes ?? {}) : {};
  let normalizedBytes=0;
  const operations: OpenApiOperation[] = [], diagnostics: OpenApiDiagnostic[] = [], seenIds = new Map<string, OpenApiOperation[]>();
  for (const [path, rawPath] of Object.entries(paths)) {
    if (path.startsWith("x-")) continue;
    const pathItem = object(rawPath);
    if (pathItem.$ref !== undefined) diagnostics.push({ code: "OPENAPI_PATH_REF_UNSUPPORTED", message: "Referenced path items require explicit review and expansion." });
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const) {
      if (pathItem[method] === undefined) continue;
      if (operations.length >= OPENAPI_LIMITS.operations) fail("OPENAPI_LIMIT", "OpenAPI operation limit exceeded");
      const operation: OpenApiOperation = { operationId: null, alias: `api_${requestDigest([method, path]).slice(0, 32)}`,
        method: method.toUpperCase() as OpenApiMethod, path, summary: "", parameters: [], requestBody: null,
        responseSchemas: [], securityRequirements: [], serverCandidates: [], security: null, securityChoices: [], effect: "unknown", reviewRequired: true, compatible: false, diagnostics: [], template: null };
      operations.push(operation);
      try {
        safePath(path, true);
        if (method === "trace") fail("OPENAPI_METHOD_UNSUPPORTED", "TRACE operations are unsupported");
        if (pathItem.$ref !== undefined) fail("OPENAPI_PATH_REF_UNSUPPORTED", "Referenced path items require explicit review and expansion");
        const input = object(pathItem[method]);
        if (input.operationId !== undefined) {
          operation.operationId = text(input.operationId, 128);
          seenIds.set(operation.operationId, [...seenIds.get(operation.operationId) ?? [], operation]);
        } else operation.diagnostics.push({ code: "OPENAPI_OPERATION_ID_MISSING", message: "A stable alias identifies this unnamed operation." });
        operation.summary = typeof input.summary === "string" ? input.summary.slice(0, 1024) : operation.operationId ?? `${method.toUpperCase()} ${path}`;
        const declaredServers = array(input.servers ?? pathItem.servers ?? root.servers ?? []);
        if (!declaredServers.length) fail("OPENAPI_SERVER_UNDECLARED", "The selected fixed server must appear in the document");
        const candidates = declaredServers.map(value => {
          const candidate = object(value);
          if (candidate.variables !== undefined) fail("OPENAPI_SERVER_VARIABLES_UNSUPPORTED", "Server variables require an explicitly expanded server declaration");
          return text(candidate.url, 2048);
        });
        operation.serverCandidates = candidates;
        if (!candidates.includes(options.serverUrl) && !candidates.some(candidate => { try { return server(candidate, options.testLoopback).href.replace(/\/$/, "") === selectedUrl; } catch { return false; } })) fail("OPENAPI_SERVER_OVERRIDE_UNSUPPORTED", "Operation does not use the selected fixed server");
        operation.securityRequirements = input.security ?? root.security ?? [];
        const alternatives = array(operation.securityRequirements);
        if (alternatives.length > 8) fail("OPENAPI_SECURITY_ALTERNATIVES_UNSUPPORTED", "At most eight authentication alternatives can be reviewed");
        operation.securityChoices = alternatives.map((alternative, index) => {
          try { return { index, security: security([alternative], schemes, resolve), diagnostics: [] }; }
          catch (error) { return { index, security: null, diagnostics: [{ code: error instanceof PlatformError ? error.code : "OPENAPI_SECURITY_UNSUPPORTED", message: error instanceof Error ? error.message : "Unsupported authentication alternative" }] }; }
        });
        const chosen = options.securitySelections?.[operation.alias];
        if (chosen !== undefined && chosen >= alternatives.length) fail("OPENAPI_SECURITY_SELECTION_INVALID", "Selected authentication alternative is unavailable");
        operation.security = security(chosen === undefined ? operation.securityRequirements : [alternatives[chosen]!], schemes, resolve);
        const parameters = new Map<string, OpenApiParameter>();
        for (const level of [pathItem.parameters, input.parameters]) {
          if (level === undefined) continue;
          const duplicates = new Set<string>();
          for (const raw of array(level)) {
            const parameter = object(resolve(raw)), name = text(parameter.name, 128), location = parameter.in;
            if (!["path", "query", "header"].includes(String(location))) fail("OPENAPI_PARAMETER_UNSUPPORTED", "Only path, query and header parameters are supported");
            if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) fail("OPENAPI_PARAMETER_UNSUPPORTED", "Unsafe parameter name");
            if (authField.test(name) || operation.security.type !== "none" && name.toLowerCase() === (operation.security.name ?? "authorization").toLowerCase()) fail("OPENAPI_AUTH_INPUT_UNSUPPORTED", "Authentication parameters require trusted credential references");
            if (location === "header") headerName(name);
            const key = `${location}:${location === "header" ? name.toLowerCase() : name}`;
            if (duplicates.has(key)) fail("OPENAPI_PARAMETER_DUPLICATE", "Duplicate parameter definition");
            duplicates.add(key);
            if (parameter.schema === undefined || parameter.content !== undefined || parameter.allowReserved === true || parameter.allowEmptyValue === true) fail("OPENAPI_PARAMETER_UNSUPPORTED", "Parameter serialization is unsupported");
            const definition = schema(parameter.schema, version), type = typeof definition === "object" ? definition.type : undefined;
            const supported = ["string", "number", "integer", "boolean"];
            if (!supported.includes(String(type)) && !(location === "query" && type === "array" && typeof definition === "object" && definition.items && typeof definition.items === "object" && !Array.isArray(definition.items) && supported.includes(String(definition.items.type)))) fail("OPENAPI_PARAMETER_UNSUPPORTED", "Parameters support scalars and scalar query arrays");
            const style = location === "query" ? "form" : "simple", explode = parameter.explode ?? location === "query";
            if (parameter.style !== undefined && parameter.style !== style || typeof explode !== "boolean") fail("OPENAPI_PARAMETER_UNSUPPORTED", "Parameter style is unsupported");
            if (location === "path" && parameter.required !== true) fail("OPENAPI_PARAMETER_UNSUPPORTED", "Path parameters must be required");
            parameters.set(key, { name, in: location as OpenApiParameter["in"], required: parameter.required === true, style, explode, schema: definition });
          }
        }
        operation.parameters = [...parameters.values()];
        if (operation.parameters.length > OPENAPI_LIMITS.parameters) fail("OPENAPI_LIMIT", "Operation parameter limit exceeded");
        const placeholders = [...path.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]!);
        const pathParameters = operation.parameters.filter(parameter => parameter.in === "path").map(parameter => parameter.name);
        if (placeholders.some(name => !pathParameters.includes(name)) || pathParameters.some(name => !placeholders.includes(name))) fail("OPENAPI_PARAMETER_UNSUPPORTED", "Path template and required parameters do not match");
        if (input.requestBody !== undefined) {
          const body = object(resolve(input.requestBody)), content = object(body.content), media = content["application/json"];
          if (Object.keys(content).length !== 1 || media === undefined || method === "get" || method === "head") fail("OPENAPI_BODY_UNSUPPORTED", "Only unambiguous JSON request bodies on body-capable methods are supported");
          operation.requestBody = { required: body.required === true, contentType: "application/json", schema: schema(object(media).schema ?? true, version) };
        }
        if (input.responses !== undefined) {
          for (const [status, raw] of Object.entries(object(input.responses))) {
            const response = object(resolve(raw));
            if (response.content === undefined) continue;
            for (const [contentType, media] of Object.entries(object(response.content))) {
              const responseSchema = object(media).schema;
              if (responseSchema !== undefined) operation.responseSchemas.push({ status, contentType, schema: responseSchema });
            }
          }
        }
        const content: Omit<RequestTemplate, "digest"> = { schemaVersion: 1, serverUrl: selectedUrl, serverOrigin: selected.origin,
          method: operation.method, path, parameters: operation.parameters, requestBody: operation.requestBody,
          security: operation.security, effect: "unknown", reviewRequired: true };
        operation.template = { ...content, digest: requestDigest(content) }; operation.compatible = true;
      } catch (error) {
        operation.diagnostics.push(error instanceof PlatformError ? { code: error.code, message: error.message }
          : { code: "OPENAPI_INVALID", message: "Invalid operation metadata." });
      }
      normalizedBytes+=Buffer.byteLength(canonicalJson(operation));
      if(normalizedBytes>OPENAPI_LIMITS.normalizedBytes)fail("OPENAPI_LIMIT","Normalized API catalog exceeds byte limits");
    }
  }
  for (const duplicates of seenIds.values()) if (duplicates.length > 1) for (const operation of duplicates) {
    operation.compatible = false; operation.template = null;
    operation.diagnostics.push({ code: "OPENAPI_OPERATION_ID_COLLISION", message: "Operation IDs must be unique before activation." });
  }
  if (!operations.length) diagnostics.push({ code: "OPENAPI_NO_OPERATIONS", message: "No supported HTTP operation definitions were found." });
  if (Object.keys(options.securitySelections ?? {}).some(alias => !operations.some(operation => operation.alias === alias))) fail("OPENAPI_SECURITY_SELECTION_INVALID", "Authentication selection refers to an unavailable operation");
  return { schemaVersion: 1, openapi: version, title: text(object(root.info).title, 256), digest: requestDigest(root),
    server: { url: selectedUrl, origin: selected.origin }, operations, diagnostics };
}

function parameterValue(value: Json, parameter: OpenApiParameter): string[] {
  validate(value, parameter.schema);
  const values = Array.isArray(value) ? value : [value];
  if (values.some(item => !["string", "boolean", "number"].includes(typeof item))) fail("OPENAPI_INPUT_INVALID", "Expected scalar parameter values");
  return values.map(item => String(item));
}
function credentialText(value: string): string {
  if (!value || Buffer.byteLength(value) > 8192 || /[\x00-\x1f\x7f]/.test(value)) fail("OPENAPI_CREDENTIAL_INVALID", "Credential value is invalid");
  return value;
}

/** Persist this template in the authorized immutable binding; a digest alone is not authority. */
export function compileOpenApiRequest(template: RequestTemplate, input: RequestArguments,
  credentialReferences: Readonly<Record<string, string>> = {}): CompiledOpenApiRequest {
  const { digest, ...content } = template;
  if (digest !== requestDigest(content) || template.schemaVersion !== 1 || template.effect !== "unknown" || template.reviewRequired !== true) fail("OPENAPI_TEMPLATE_INVALID", "Request template changed");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(template.method)) fail("OPENAPI_TEMPLATE_INVALID", "Unsupported HTTP method");
  const argumentsCopy = object(boundedCopy(input, OPENAPI_LIMITS.valueNodes, OPENAPI_LIMITS.valueDepth));
  function noAuthFields(value: Json): void {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(noAuthFields); return; }
    for (const [name, child] of Object.entries(value)) {
      if (authField.test(name)) fail("OPENAPI_AUTH_INPUT_UNSUPPORTED", "Authentication fields require trusted credential references");
      noAuthFields(child);
    }
  }
  noAuthFields(argumentsCopy);
  if (Object.keys(argumentsCopy).some(key => !["path", "query", "headers", "body"].includes(key))) fail("OPENAPI_INPUT_INVALID", "Unexpected request argument");
  if (Buffer.byteLength(canonicalJson(argumentsCopy)) > OPENAPI_LIMITS.requestBytes) fail("OPENAPI_LIMIT", "Request input exceeds byte limit");
  let path = safePath(template.path, true);
  const groups = { path: object(argumentsCopy.path ?? {}), query: object(argumentsCopy.query ?? {}), header: object(argumentsCopy.headers ?? {}) };
  const headers: Record<string, string> = { accept: "application/json" }, query = new URLSearchParams();
  for (const [location, values] of Object.entries(groups)) {
    for (const name of Object.keys(values)) if (!template.parameters.some(parameter => parameter.in === location && parameter.name === name)) fail("OPENAPI_INPUT_INVALID", "Unexpected request parameter");
  }
  for (const parameter of template.parameters) {
    const values = groups[parameter.in], supplied = Object.hasOwn(values, parameter.name);
    if (!supplied) { if (parameter.required) fail("OPENAPI_INPUT_INVALID", "Required request parameter is missing"); continue; }
    const parts = parameterValue(values[parameter.name]!, parameter);
    if (parameter.in === "path") {
      const part = parts[0]!;
      if (!part || /[\\/%?#{}\x00-\x1f\x7f]/.test(part) || part === "." || part === "..") fail("OPENAPI_INPUT_INVALID", "Path parameter cannot alter the destination or path structure");
      path = path.replaceAll(`{${parameter.name}}`, encodeURIComponent(part));
    } else if (parameter.in === "header") {
      const name = headerName(parameter.name), value = parts[0]!;
      if (authField.test(name) || /[\x00-\x1f\x7f]/.test(value)) fail("OPENAPI_INPUT_INVALID", "Invalid request header");
      headers[name] = value;
    } else {
      if (authField.test(parameter.name)) fail("OPENAPI_AUTH_INPUT_UNSUPPORTED", "Authentication fields require trusted credential references");
      if (parameter.explode) parts.forEach(part => query.append(parameter.name, part));
      else query.append(parameter.name, parts.join(","));
    }
  }
  if (/[{}]/.test(path)) fail("OPENAPI_INPUT_INVALID", "Unresolved path parameter");
  const base = new URL(template.serverUrl);
  if (base.origin !== template.serverOrigin || base.username || base.password || base.search || base.hash) fail("OPENAPI_TEMPLATE_INVALID", "Server origin changed");
  const basePath = base.pathname.replace(/\/$/, "");
  const url = new URL(template.serverUrl + path);
  if (url.origin !== template.serverOrigin || !url.pathname.startsWith(basePath + "/")) fail("OPENAPI_INPUT_INVALID", "Request escaped its selected destination");
  url.search = query.toString();
  let body: string | undefined;
  if (argumentsCopy.body !== undefined) {
    if (!template.requestBody) fail("OPENAPI_INPUT_INVALID", "Operation does not accept a body");
    validate(argumentsCopy.body, template.requestBody.schema); body = JSON.stringify(argumentsCopy.body);
    headers["content-type"] = "application/json";
  } else if (template.requestBody?.required) fail("OPENAPI_INPUT_INVALID", "Required request body is missing");
  const credentials: CredentialRequirement[] = [];
  if (template.security.type !== "none") {
    const reference = credentialReferences[template.security.schemeId];
    if (!reference || !/^[A-Za-z0-9:._/-]{1,256}$/.test(reference)) fail("OPENAPI_CREDENTIAL_REQUIRED", "Select a trusted credential reference");
    credentials.push({ schemeId: template.security.schemeId, reference, type: template.security.type,
      in: template.security.in ?? "header", name: template.security.name ?? "authorization" });
  }
  const request: CompiledOpenApiRequest = { url: url.href, origin: url.origin, method: template.method, headers,
    ...(body !== undefined ? { body } : {}), credentials, templateDigest: template.digest, effect: "unknown", reviewRequired: true };
  if (Buffer.byteLength(JSON.stringify(request)) > OPENAPI_LIMITS.requestBytes) fail("OPENAPI_LIMIT", "Compiled request exceeds byte limit");
  return request;
}

/** Call only with vault-resolved values after current authority and exact-effect review checks. */
export function injectOpenApiCredentials(request: CompiledOpenApiRequest, resolved: Readonly<Record<string, ResolvedOpenApiCredential>>): CompiledOpenApiRequest {
  const url = new URL(request.url), headers = { ...request.headers };
  if (url.origin !== request.origin || url.username || url.password || url.hash) fail("OPENAPI_TEMPLATE_INVALID", "Request destination changed");
  for (const requirement of request.credentials) {
    const credential = resolved[requirement.reference];
    if (!credential || credential.type !== requirement.type) fail("OPENAPI_CREDENTIAL_REQUIRED", "Trusted credential type does not match the selected scheme");
    let value: string;
    if (credential.type === "basic") {
      const username = credentialText(credential.username), password = credentialText(credential.password);
      if (username.includes(":")) fail("OPENAPI_CREDENTIAL_INVALID", "Basic username contains a colon");
      value = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    } else if (credential.type === "api_key") value = credentialText(credential.value);
    else value = `Bearer ${credentialText(credential.token)}`;
    if (requirement.in === "query") {
      if (credential.type !== "api_key" || url.searchParams.has(requirement.name)) fail("OPENAPI_CREDENTIAL_INVALID", "Credential query parameter conflicts with request input");
      url.searchParams.set(requirement.name, value);
    } else {
      const name = headerName(requirement.name, true);
      if (Object.hasOwn(headers, name)) fail("OPENAPI_CREDENTIAL_INVALID", "Credential header conflicts with request input");
      headers[name] = value;
    }
  }
  if (Buffer.byteLength(JSON.stringify(headers)) > 16384) fail("OPENAPI_LIMIT", "Credential headers exceed byte limit");
  return { ...request, url: url.href, headers };
}
