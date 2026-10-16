/**
 * Pure validation and readiness checks for extension packages.
 *
 * This is deliberately separate from ExtensionResolver. The resolver compiles
 * already trusted declarations into a run snapshot; this module decides
 * whether an untrusted package manifest is well formed and whether a runtime
 * can use it. It never imports an entrypoint, installs dependencies, expands
 * secrets, starts an MCP process, or executes plugin code.
 */

export const EXTENSION_PACKAGE_MANIFEST_VERSION = 1 as const;

export type ExtensionPackageKind = "skill" | "plugin" | "mcp_adapter";
export type ExtensionPackageExecutionMode = "declarative" | "plugin" | "mcp_stdio" | "mcp_http";
export type ExtensionConfigValueType = "string" | "number" | "integer" | "boolean" | "array" | "object";

export interface ExtensionRuntimeRequirement {
  id: string;
  versionRange: string;
  requiredFeatures?: readonly string[];
}

export interface ExtensionPackageDependency {
  kind: ExtensionPackageKind;
  id: string;
  versionRange: string;
  optional?: boolean;
}

export interface ExtensionConfigProperty {
  type: ExtensionConfigValueType;
  description?: string;
  default?: unknown;
  enum?: readonly unknown[];
  items?: ExtensionConfigProperty;
  properties?: Readonly<Record<string, ExtensionConfigProperty>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

export interface ExtensionConfigurationSchema {
  type: "object";
  properties: Readonly<Record<string, ExtensionConfigProperty>>;
  required?: readonly string[];
  additionalProperties?: boolean;
}

export interface DeclarativeSkillExecution {
  mode: "declarative";
  instructionRef: string;
}

export interface PluginExecution {
  mode: "plugin";
  entrypoint: string;
}

export interface McpStdioExecution {
  mode: "mcp_stdio";
  serverName: string;
  command: string;
  args?: readonly string[];
  envRefs?: Readonly<Record<string, string>>;
}

export interface McpHttpExecution {
  mode: "mcp_http";
  serverName: string;
  endpoint: string;
  protocolVersion: string;
}

export type ExtensionPackageExecution =
  | DeclarativeSkillExecution
  | PluginExecution
  | McpStdioExecution
  | McpHttpExecution;

export interface ExtensionPackageManifest {
  manifestVersion: typeof EXTENSION_PACKAGE_MANIFEST_VERSION;
  id: string;
  version: string;
  checksum: string;
  kind: ExtensionPackageKind;
  runtime: ExtensionRuntimeRequirement;
  execution: ExtensionPackageExecution;
  dependencies: readonly ExtensionPackageDependency[];
  permissions: readonly string[];
  configSchema?: ExtensionConfigurationSchema;
}

export type ExtensionPackageValidationFailureCode =
  | "manifest_not_object"
  | "manifest_version_invalid"
  | "manifest_version_unsupported"
  | "unknown_field"
  | "field_required"
  | "field_invalid_type"
  | "id_invalid"
  | "version_invalid"
  | "checksum_invalid"
  | "kind_invalid"
  | "runtime_invalid"
  | "version_range_invalid"
  | "dependency_invalid"
  | "dependency_duplicate"
  | "dependency_self_reference"
  | "permission_invalid"
  | "config_schema_invalid"
  | "config_schema_duplicate_required"
  | "execution_invalid"
  | "execution_mode_mismatch"
  | "entrypoint_invalid"
  | "mcp_transport_invalid"
  | "mcp_endpoint_invalid"
  | "mcp_env_reference_invalid";

export interface ExtensionPackageValidationFailure {
  phase: "validation";
  code: ExtensionPackageValidationFailureCode;
  path: string;
  message: string;
}

export type ExtensionPackageReadinessFailureCode =
  | "runtime_incompatible"
  | "runtime_version_incompatible"
  | "runtime_feature_missing"
  | "execution_mode_unsupported"
  | "checksum_untrusted"
  | "dependency_missing"
  | "dependency_version_incompatible"
  | "dependency_not_ready"
  | "permission_not_granted"
  | "configuration_invalid"
  | "configuration_required"
  | "configuration_type_invalid"
  | "configuration_enum_invalid"
  | "configuration_range_invalid"
  | "configuration_unknown_key";

export interface ExtensionPackageReadinessFailure {
  phase: "readiness";
  code: ExtensionPackageReadinessFailureCode;
  path: string;
  message: string;
  dependency?: Pick<ExtensionPackageDependency, "kind" | "id" | "versionRange">;
  permission?: string;
}

export type ExtensionPackageFailure = ExtensionPackageValidationFailure | ExtensionPackageReadinessFailure;

export type ExtensionPackageValidationResult =
  | { ok: true; manifest: Readonly<ExtensionPackageManifest> }
  | { ok: false; failures: readonly ExtensionPackageValidationFailure[] };

export interface InstalledExtensionPackage {
  kind: ExtensionPackageKind;
  id: string;
  version: string;
  ready?: boolean;
}

export interface TrustedExtensionPackageChecksum extends InstalledExtensionPackage {
  checksum: string;
}

export interface ExtensionPackageRuntime {
  runtimeId: string;
  runtimeVersion: string;
  supportedFeatures?: readonly string[];
  supportedExecutionModes: readonly ExtensionPackageExecutionMode[];
  trustedChecksums: readonly TrustedExtensionPackageChecksum[];
  installedPackages?: readonly InstalledExtensionPackage[];
  grantedPermissions?: readonly string[];
  configuration?: Readonly<Record<string, unknown>>;
}

export interface ExtensionPackageReadiness {
  status: "ready" | "blocked";
  ready: boolean;
  failures: readonly ExtensionPackageReadinessFailure[];
  configuration: Readonly<Record<string, unknown>>;
}

export type ExtensionPackageAssessmentResult =
  | { ok: false; phase: "validation"; failures: readonly ExtensionPackageValidationFailure[] }
  | { ok: true; phase: "readiness"; manifest: Readonly<ExtensionPackageManifest>; readiness: ExtensionPackageReadiness };

type JsonObject = Record<string, unknown>;
type SemVer = { major: number; minor: number; patch: number; prerelease: readonly string[] };

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/i;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const ENV_REFERENCE_PATTERN = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;
const ENTRYPOINT_PATTERN = /^[A-Za-z0-9_@./:-]+$/;
const PERMISSION_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;
const CONFIG_TYPES = new Set<ExtensionConfigValueType>(["string", "number", "integer", "boolean", "array", "object"]);
const MANIFEST_FIELDS = new Set([
  "manifestVersion", "id", "version", "checksum", "kind", "runtime", "execution",
  "dependencies", "permissions", "configSchema",
]);

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeDeep<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as JsonObject)) freezeDeep(child);
  return Object.freeze(value);
}

function failure(
  code: ExtensionPackageValidationFailureCode,
  path: string,
  message: string,
): ExtensionPackageValidationFailure {
  return { phase: "validation", code, path, message };
}

function readinessFailure(
  code: ExtensionPackageReadinessFailureCode,
  path: string,
  message: string,
  extra: Partial<Pick<ExtensionPackageReadinessFailure, "dependency" | "permission">> = {},
): ExtensionPackageReadinessFailure {
  return { phase: "readiness", code, path, message, ...extra };
}

function normalizedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function parseSemVer(value: unknown): SemVer | undefined {
  if (typeof value !== "string") return undefined;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareSemVer(left: SemVer, right: SemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

type VersionConstraint = (version: SemVer) => boolean;

function wildcardConstraint(raw: string): VersionConstraint | undefined {
  const parts = raw.split(".");
  if (parts.length > 3 || parts.length === 0 || parts.some((part) => !/^\d+$|^[xX*]$/.test(part))) return undefined;
  const wildcardIndex = parts.findIndex((part) => /^[xX*]$/.test(part));
  if (wildcardIndex === -1) return undefined;
  const prefix = parts.slice(0, wildcardIndex).map(Number);
  if (wildcardIndex === 0) return () => true;
  if (wildcardIndex === 1) return (version) => version.major === prefix[0];
  return (version) => version.major === prefix[0] && version.minor === prefix[1];
}

function compileVersionRange(range: string): readonly (readonly VersionConstraint[])[] | undefined {
  const trimmed = range.trim();
  if (!trimmed) return undefined;
  const groups: (readonly VersionConstraint[])[] = [];
  for (const rawGroup of trimmed.split("||")) {
    const tokens = rawGroup.trim().replaceAll(",", " ").split(/\s+/).filter(Boolean);
    if (!tokens.length) return undefined;
    const constraints: VersionConstraint[] = [];
    for (const token of tokens) {
      if (/^(?:\*|x|X)$/.test(token)) continue;
      const wildcard = wildcardConstraint(token);
      if (wildcard) {
        constraints.push(wildcard);
        continue;
      }
      const operatorMatch = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
      const operator = operatorMatch?.[1] ?? "=";
      const versionText = operatorMatch?.[2] ?? "";
      const version = parseSemVer(versionText);
      if (!version) return undefined;
      if (operator === "=") constraints.push((candidate) => compareSemVer(candidate, version) === 0);
      else if (operator === ">") constraints.push((candidate) => compareSemVer(candidate, version) > 0);
      else if (operator === ">=") constraints.push((candidate) => compareSemVer(candidate, version) >= 0);
      else if (operator === "<") constraints.push((candidate) => compareSemVer(candidate, version) < 0);
      else if (operator === "<=") constraints.push((candidate) => compareSemVer(candidate, version) <= 0);
      else if (operator === "~") {
        const upper: SemVer = { major: version.major, minor: version.minor + 1, patch: 0, prerelease: [] };
        constraints.push((candidate) => compareSemVer(candidate, version) >= 0 && compareSemVer(candidate, upper) < 0);
      } else {
        const upper: SemVer = version.major > 0
          ? { major: version.major + 1, minor: 0, patch: 0, prerelease: [] }
          : version.minor > 0
            ? { major: 0, minor: version.minor + 1, patch: 0, prerelease: [] }
            : { major: 0, minor: 0, patch: version.patch + 1, prerelease: [] };
        constraints.push((candidate) => compareSemVer(candidate, version) >= 0 && compareSemVer(candidate, upper) < 0);
      }
    }
    groups.push(constraints);
  }
  return groups;
}

function satisfiesVersion(version: string, range: string): boolean {
  const candidate = parseSemVer(version);
  const groups = compileVersionRange(range);
  return Boolean(candidate && groups?.some((constraints) => constraints.every((constraint) => constraint(candidate))));
}

function validateStringList(
  value: unknown,
  path: string,
  failures: ExtensionPackageValidationFailure[],
): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    failures.push(failure("field_invalid_type", path, "must be a non-empty string array"));
    return undefined;
  }
  return uniqueStrings(value.map((entry) => entry.trim()));
}

function validateConfigProperty(
  value: unknown,
  path: string,
  failures: ExtensionPackageValidationFailure[],
  depth = 0,
): ExtensionConfigProperty | undefined {
  if (!isRecord(value) || depth > 16) {
    failures.push(failure("config_schema_invalid", path, "must be an object with a supported type"));
    return undefined;
  }
  const type = value.type;
  if (typeof type !== "string" || !CONFIG_TYPES.has(type as ExtensionConfigValueType)) {
    failures.push(failure("config_schema_invalid", `${path}.type`, "must be one of string, number, integer, boolean, array, or object"));
    return undefined;
  }
  const allowed = new Set(["type", "description", "default", "enum", "items", "properties", "required", "additionalProperties", "minimum", "maximum", "minLength", "maxLength"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failures.push(failure("unknown_field", `${path}.${key}`, "is not supported in a configuration schema"));
  }
  const property: ExtensionConfigProperty = { type: type as ExtensionConfigValueType };
  if (value.description !== undefined) {
    if (typeof value.description !== "string") failures.push(failure("field_invalid_type", `${path}.description`, "must be a string"));
    else property.description = value.description.trim();
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) failures.push(failure("config_schema_invalid", `${path}.enum`, "must be a non-empty array"));
    else property.enum = value.enum;
  }
  for (const numericField of ["minimum", "maximum", "minLength", "maxLength"] as const) {
    if (value[numericField] !== undefined && (typeof value[numericField] !== "number" || !Number.isFinite(value[numericField]) || value[numericField] < 0)) {
      failures.push(failure("config_schema_invalid", `${path}.${numericField}`, "must be a finite non-negative number"));
    } else if (value[numericField] !== undefined) {
      property[numericField] = value[numericField] as never;
    }
  }
  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties !== "boolean") failures.push(failure("field_invalid_type", `${path}.additionalProperties`, "must be a boolean"));
    else property.additionalProperties = value.additionalProperties;
  }
  if (type === "array") {
    const items = validateConfigProperty(value.items, `${path}.items`, failures, depth + 1);
    if (!items) failures.push(failure("config_schema_invalid", `${path}.items`, "is required for array properties"));
    else property.items = items;
  }
  if (type === "object") {
    if (!isRecord(value.properties)) failures.push(failure("config_schema_invalid", `${path}.properties`, "is required for object properties"));
    else {
      const properties: Record<string, ExtensionConfigProperty> = {};
      for (const [key, child] of Object.entries(value.properties)) {
        const normalizedKey = key.trim();
        if (!normalizedKey) failures.push(failure("config_schema_invalid", `${path}.properties`, "cannot contain an empty key"));
        const parsed = validateConfigProperty(child, `${path}.properties.${key}`, failures, depth + 1);
        if (parsed) properties[normalizedKey] = parsed;
      }
      property.properties = properties;
    }
    if (value.required !== undefined) {
      if (Array.isArray(value.required)) {
        const seen = new Set<string>();
        for (const key of value.required) {
          if (typeof key === "string" && seen.has(key)) failures.push(failure("config_schema_duplicate_required", `${path}.required`, `contains duplicate property ${key}`));
          if (typeof key === "string") seen.add(key);
        }
      }
      const required = validateStringList(value.required, `${path}.required`, failures);
      if (required) {
        property.required = required;
        for (const key of required) {
          if (!property.properties?.[key]) failures.push(failure("config_schema_invalid", `${path}.required`, `references unknown property ${key}`));
        }
      }
    }
  } else if (value.properties !== undefined || value.required !== undefined) {
    failures.push(failure("config_schema_invalid", path, "properties and required are only valid for object properties"));
  }
  if (value.default !== undefined) property.default = value.default;
  if (property.default !== undefined) validateConfigDefault(property.default, property, `${path}.default`, failures);
  return property;
}

function validateConfigDefault(
  value: unknown,
  schema: ExtensionConfigProperty,
  path: string,
  failures: ExtensionPackageValidationFailure[],
): void {
  if (!valueMatchesType(value, schema.type)) {
    failures.push(failure("config_schema_invalid", path, `default must be ${schema.type}`));
    return;
  }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    failures.push(failure("config_schema_invalid", path, "default must be one of the declared values"));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) failures.push(failure("config_schema_invalid", path, `default must be at least ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) failures.push(failure("config_schema_invalid", path, `default must be at most ${schema.maximum}`));
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) failures.push(failure("config_schema_invalid", path, `default must contain at least ${schema.minLength} characters`));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) failures.push(failure("config_schema_invalid", path, `default must contain at most ${schema.maxLength} characters`));
  }
  if (schema.type === "array" && schema.items) {
    for (const [index, entry] of (value as unknown[]).entries()) validateConfigDefault(entry, schema.items, `${path}[${index}]`, failures);
  }
  if (schema.type === "object" && schema.properties) {
    const object = value as JsonObject;
    for (const [key, property] of Object.entries(schema.properties)) {
      if (object[key] !== undefined) validateConfigDefault(object[key], property, `${path}.${key}`, failures);
      else if (schema.required?.includes(key) && property.default === undefined) failures.push(failure("config_schema_invalid", `${path}.${key}`, "required default is missing"));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!schema.properties[key]) failures.push(failure("config_schema_invalid", `${path}.${key}`, "default contains an undeclared property"));
      }
    }
  }
}

function validateConfigSchema(value: unknown, failures: ExtensionPackageValidationFailure[]): ExtensionConfigurationSchema | undefined {
  if (!isRecord(value)) {
    failures.push(failure("config_schema_invalid", "configSchema", "must be an object"));
    return undefined;
  }
  const allowed = new Set(["type", "properties", "required", "additionalProperties"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) failures.push(failure("unknown_field", `configSchema.${key}`, "is not supported in a configuration schema"));
  }
  if (value.type !== "object") failures.push(failure("config_schema_invalid", "configSchema.type", "must be object"));
  if (!isRecord(value.properties)) failures.push(failure("config_schema_invalid", "configSchema.properties", "must be an object"));
  const properties: Record<string, ExtensionConfigProperty> = {};
  if (isRecord(value.properties)) {
    for (const [key, property] of Object.entries(value.properties)) {
      const normalizedKey = key.trim();
      if (!normalizedKey) failures.push(failure("config_schema_invalid", "configSchema.properties", "cannot contain an empty key"));
      const parsed = validateConfigProperty(property, `configSchema.properties.${key}`, failures);
      if (parsed) properties[normalizedKey] = parsed;
    }
  }
  const schema: ExtensionConfigurationSchema = { type: "object", properties };
  if (value.required !== undefined) {
    if (Array.isArray(value.required)) {
      const seen = new Set<string>();
      for (const key of value.required) {
        if (typeof key === "string" && seen.has(key)) failures.push(failure("config_schema_duplicate_required", "configSchema.required", `contains duplicate property ${key}`));
        if (typeof key === "string") seen.add(key);
      }
    }
    const required = validateStringList(value.required, "configSchema.required", failures);
    if (required) {
      schema.required = required;
      const seen = new Set<string>();
      for (const key of required) {
        if (seen.has(key)) failures.push(failure("config_schema_duplicate_required", "configSchema.required", `contains duplicate property ${key}`));
        seen.add(key);
        if (!properties[key]) failures.push(failure("config_schema_invalid", "configSchema.required", `references unknown property ${key}`));
      }
    }
  }
  if (value.additionalProperties !== undefined) {
    if (typeof value.additionalProperties !== "boolean") failures.push(failure("field_invalid_type", "configSchema.additionalProperties", "must be a boolean"));
    else schema.additionalProperties = value.additionalProperties;
  }
  return schema;
}

function validateExecution(
  value: unknown,
  kind: ExtensionPackageKind,
  failures: ExtensionPackageValidationFailure[],
): ExtensionPackageExecution | undefined {
  if (!isRecord(value)) {
    failures.push(failure("execution_invalid", "execution", "must be an object"));
    return undefined;
  }
  const mode = value.mode;
  if (typeof mode !== "string") {
    failures.push(failure("execution_invalid", "execution.mode", "is required"));
    return undefined;
  }
  const expectedMode = kind === "skill" ? "declarative" : kind === "plugin" ? "plugin" : undefined;
  if (expectedMode && mode !== expectedMode) failures.push(failure("execution_mode_mismatch", "execution.mode", `${kind} packages must use ${expectedMode} execution`));
  if (kind === "skill") {
    for (const key of Object.keys(value)) if (!["mode", "instructionRef"].includes(key)) failures.push(failure("unknown_field", `execution.${key}`, "is not valid for a declarative skill"));
    const instructionRef = normalizedString(value.instructionRef);
    if (!instructionRef) failures.push(failure("field_required", "execution.instructionRef", "is required for a skill"));
    else if (instructionRef.startsWith("/") || instructionRef.includes("..")) failures.push(failure("execution_invalid", "execution.instructionRef", "must be a package-relative instruction reference"));
    return instructionRef ? { mode: "declarative", instructionRef } : undefined;
  }
  if (kind === "plugin") {
    for (const key of Object.keys(value)) if (!["mode", "entrypoint"].includes(key)) failures.push(failure("unknown_field", `execution.${key}`, "is not valid for a plugin"));
    const entrypoint = normalizedString(value.entrypoint);
    if (!entrypoint) failures.push(failure("field_required", "execution.entrypoint", "is required for a plugin"));
    else if (!ENTRYPOINT_PATTERN.test(entrypoint) || entrypoint.includes("..") || entrypoint.startsWith("/")) failures.push(failure("entrypoint_invalid", "execution.entrypoint", "must be a safe package/export reference, not a filesystem path"));
    return entrypoint ? { mode: "plugin", entrypoint } : undefined;
  }
  if (mode !== "mcp_stdio" && mode !== "mcp_http") {
    failures.push(failure("mcp_transport_invalid", "execution.mode", "MCP adapters must use mcp_stdio or mcp_http"));
    return undefined;
  }
  const serverName = normalizedString(value.serverName);
  if (!serverName) failures.push(failure("field_required", "execution.serverName", "is required for an MCP adapter"));
  if (mode === "mcp_stdio") {
    for (const key of Object.keys(value)) if (!["mode", "serverName", "command", "args", "envRefs"].includes(key)) failures.push(failure("unknown_field", `execution.${key}`, "is not valid for a stdio MCP adapter"));
    const command = normalizedString(value.command);
    if (!command) failures.push(failure("field_required", "execution.command", "is required for stdio MCP adapters"));
    else if (command.includes("\0")) failures.push(failure("mcp_transport_invalid", "execution.command", "cannot contain a NUL byte"));
    let args: string[] | undefined;
    if (value.args !== undefined) args = validateStringList(value.args, "execution.args", failures);
    const envRefs: Record<string, string> = {};
    if (value.envRefs !== undefined) {
      if (!isRecord(value.envRefs)) failures.push(failure("mcp_env_reference_invalid", "execution.envRefs", "must be an object"));
      else {
        for (const [key, raw] of Object.entries(value.envRefs)) {
          if (!ENV_NAME_PATTERN.test(key) || typeof raw !== "string" || !ENV_REFERENCE_PATTERN.test(raw)) {
            failures.push(failure("mcp_env_reference_invalid", `execution.envRefs.${key}`, "must map an environment name to a ${UPPER_SNAKE_CASE} reference"));
          } else envRefs[key] = raw;
        }
      }
    }
    return serverName && command ? { mode: "mcp_stdio", serverName, command, ...(args ? { args } : {}), ...(Object.keys(envRefs).length ? { envRefs } : {}) } : undefined;
  }
  for (const key of Object.keys(value)) if (!["mode", "serverName", "endpoint", "protocolVersion"].includes(key)) failures.push(failure("unknown_field", `execution.${key}`, "is not valid for an HTTP MCP adapter"));
  const endpoint = normalizedString(value.endpoint);
  const protocolVersion = normalizedString(value.protocolVersion);
  if (!endpoint) failures.push(failure("field_required", "execution.endpoint", "is required for HTTP MCP adapters"));
  else {
    try {
      const parsed = new URL(endpoint);
      const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !localHttp) failures.push(failure("mcp_endpoint_invalid", "execution.endpoint", "must use HTTPS unless it targets loopback"));
    } catch {
      failures.push(failure("mcp_endpoint_invalid", "execution.endpoint", "must be an absolute URL"));
    }
  }
  if (!protocolVersion) failures.push(failure("field_required", "execution.protocolVersion", "is required for HTTP MCP adapters"));
  return serverName && endpoint && protocolVersion ? { mode: "mcp_http", serverName, endpoint, protocolVersion } : undefined;
}

function validateDependencies(value: unknown, id: string, failures: ExtensionPackageValidationFailure[]): ExtensionPackageDependency[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    failures.push(failure("dependency_invalid", "dependencies", "must be an array"));
    return [];
  }
  const dependencies: ExtensionPackageDependency[] = [];
  const identities = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `dependencies[${index}]`;
    if (!isRecord(raw)) {
      failures.push(failure("dependency_invalid", path, "must be an object"));
      continue;
    }
    const kind = raw.kind;
    const dependencyId = normalizedString(raw.id);
    const versionRange = normalizedString(raw.versionRange);
    if (kind !== "skill" && kind !== "plugin" && kind !== "mcp_adapter") failures.push(failure("dependency_invalid", `${path}.kind`, "must be skill, plugin, or mcp_adapter"));
    if (!dependencyId || !ID_PATTERN.test(dependencyId)) failures.push(failure("dependency_invalid", `${path}.id`, "must be a valid package id"));
    if (!versionRange || !compileVersionRange(versionRange)) failures.push(failure("version_range_invalid", `${path}.versionRange`, "must be a supported semver range"));
    if (raw.optional !== undefined && typeof raw.optional !== "boolean") failures.push(failure("dependency_invalid", `${path}.optional`, "must be a boolean"));
    if ((kind !== "skill" && kind !== "plugin" && kind !== "mcp_adapter") || !dependencyId || !versionRange || !compileVersionRange(versionRange)) continue;
    const identity = `${kind}:${dependencyId}`;
    if (identities.has(identity)) failures.push(failure("dependency_duplicate", path, `duplicates ${identity}`));
    identities.add(identity);
    if (dependencyId === id) failures.push(failure("dependency_self_reference", path, "cannot depend on itself"));
    dependencies.push({ kind, id: dependencyId, versionRange, ...(raw.optional === true ? { optional: true } : {}) });
  }
  return dependencies;
}

function validatePermissions(value: unknown, failures: ExtensionPackageValidationFailure[]): string[] {
  if (value === undefined) return [];
  const permissions = validateStringList(value, "permissions", failures);
  if (!permissions) return [];
  for (const permission of permissions) {
    if (!PERMISSION_PATTERN.test(permission)) failures.push(failure("permission_invalid", `permissions.${permission}`, "must be a lowercase capability identifier"));
  }
  return permissions;
}

/** Validate an untrusted manifest without loading or executing its package. */
export function validateExtensionPackageManifest(input: unknown): ExtensionPackageValidationResult {
  if (!isRecord(input)) return { ok: false, failures: [failure("manifest_not_object", "$", "manifest must be an object")] };
  const failures: ExtensionPackageValidationFailure[] = [];
  for (const key of Object.keys(input)) {
    if (!MANIFEST_FIELDS.has(key)) failures.push(failure("unknown_field", key, "is not a supported manifest field"));
  }
  if (input.manifestVersion !== EXTENSION_PACKAGE_MANIFEST_VERSION) {
    const code = typeof input.manifestVersion === "number" ? "manifest_version_unsupported" : "manifest_version_invalid";
    failures.push(failure(code, "manifestVersion", `must be ${EXTENSION_PACKAGE_MANIFEST_VERSION}`));
  }
  const id = normalizedString(input.id);
  if (!id || !ID_PATTERN.test(id)) failures.push(failure("id_invalid", "id", "must be a lowercase package id using letters, numbers, ., /, _, or -"));
  const version = normalizedString(input.version);
  if (!version || !parseSemVer(version)) failures.push(failure("version_invalid", "version", "must be a complete semantic version"));
  const checksum = normalizedString(input.checksum);
  if (!checksum || !CHECKSUM_PATTERN.test(checksum)) failures.push(failure("checksum_invalid", "checksum", "must be a SHA-256 hexadecimal checksum"));
  const kind = input.kind;
  if (kind !== "skill" && kind !== "plugin" && kind !== "mcp_adapter") failures.push(failure("kind_invalid", "kind", "must be skill, plugin, or mcp_adapter"));

  let runtime: ExtensionRuntimeRequirement | undefined;
  if (!isRecord(input.runtime)) failures.push(failure("runtime_invalid", "runtime", "must be an object"));
  else {
    const runtimeId = normalizedString(input.runtime.id);
    const versionRange = normalizedString(input.runtime.versionRange);
    if (!runtimeId) failures.push(failure("field_required", "runtime.id", "is required"));
    if (!versionRange || !compileVersionRange(versionRange)) failures.push(failure("version_range_invalid", "runtime.versionRange", "must be a supported semver range"));
    let requiredFeatures: string[] | undefined;
    if (input.runtime.requiredFeatures !== undefined) requiredFeatures = validateStringList(input.runtime.requiredFeatures, "runtime.requiredFeatures", failures);
    if (runtimeId && versionRange && compileVersionRange(versionRange)) runtime = { id: runtimeId, versionRange, ...(requiredFeatures ? { requiredFeatures } : {}) };
  }

  const dependencies = validateDependencies(input.dependencies, id ?? "", failures);
  const permissions = validatePermissions(input.permissions, failures);
  const execution = kind === "skill" || kind === "plugin" || kind === "mcp_adapter"
    ? validateExecution(input.execution, kind, failures)
    : undefined;
  const configSchema = input.configSchema === undefined ? undefined : validateConfigSchema(input.configSchema, failures);

  if (failures.length || !id || !version || !checksum || !runtime || !execution || (kind !== "skill" && kind !== "plugin" && kind !== "mcp_adapter")) {
    return { ok: false, failures };
  }
  const manifest: ExtensionPackageManifest = {
    manifestVersion: EXTENSION_PACKAGE_MANIFEST_VERSION,
    id,
    version,
    checksum: checksum.toLowerCase(),
    kind,
    runtime,
    execution,
    dependencies,
    permissions,
    ...(configSchema ? { configSchema } : {}),
  };
  return { ok: true, manifest: freezeDeep(manifest) };
}

function valueMatchesType(value: unknown, type: ExtensionConfigValueType): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "array") return Array.isArray(value);
  return isRecord(value);
}

function validateConfigurationValue(
  value: unknown,
  schema: ExtensionConfigProperty,
  path: string,
  failures: ExtensionPackageReadinessFailure[],
): unknown {
  if (!valueMatchesType(value, schema.type)) {
    failures.push(readinessFailure("configuration_type_invalid", path, `must be ${schema.type}`));
    return value;
  }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    failures.push(readinessFailure("configuration_enum_invalid", path, "must be one of the declared values"));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) failures.push(readinessFailure("configuration_range_invalid", path, `must be at least ${schema.minimum}`));
    if (schema.maximum !== undefined && value > schema.maximum) failures.push(readinessFailure("configuration_range_invalid", path, `must be at most ${schema.maximum}`));
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) failures.push(readinessFailure("configuration_range_invalid", path, `must contain at least ${schema.minLength} characters`));
    if (schema.maxLength !== undefined && value.length > schema.maxLength) failures.push(readinessFailure("configuration_range_invalid", path, `must contain at most ${schema.maxLength} characters`));
  }
  if (schema.type === "array" && schema.items) return (value as unknown[]).map((entry, index) => validateConfigurationValue(entry, schema.items!, `${path}[${index}]`, failures));
  if (schema.type !== "object" || !schema.properties) return value;
  const object = value as JsonObject;
  const output: JsonObject = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (object[key] === undefined) {
      if (property.default !== undefined) output[key] = property.default;
      else if (schema.required?.includes(key)) failures.push(readinessFailure("configuration_required", `${path}.${key}`, "is required"));
      continue;
    }
    output[key] = validateConfigurationValue(object[key], property, `${path}.${key}`, failures);
  }
  for (const [key, entry] of Object.entries(object)) {
    if (schema.properties[key]) continue;
    if (schema.additionalProperties === false) failures.push(readinessFailure("configuration_unknown_key", `${path}.${key}`, "is not declared by the package configuration schema"));
    else output[key] = entry;
  }
  return output;
}

function resolveConfiguration(
  manifest: ExtensionPackageManifest,
  runtime: ExtensionPackageRuntime,
  failures: ExtensionPackageReadinessFailure[],
): Readonly<Record<string, unknown>> {
  const supplied = runtime.configuration ?? {};
  if (!isRecord(supplied)) {
    failures.push(readinessFailure("configuration_invalid", "configuration", "must be an object"));
    return {};
  }
  if (!manifest.configSchema) return freezeDeep({ ...supplied });
  const resolved = validateConfigurationValue(supplied, { type: "object", properties: manifest.configSchema.properties, required: manifest.configSchema.required, additionalProperties: manifest.configSchema.additionalProperties }, "configuration", failures);
  return freezeDeep(isRecord(resolved) ? resolved : {});
}

/** Check whether a validated package can run in the supplied runtime. */
export function assessExtensionPackageReadiness(
  manifest: Readonly<ExtensionPackageManifest>,
  runtime: ExtensionPackageRuntime,
): ExtensionPackageReadiness {
  const failures: ExtensionPackageReadinessFailure[] = [];
  if (runtime.runtimeId !== manifest.runtime.id) failures.push(readinessFailure("runtime_incompatible", "runtime.id", `requires runtime ${manifest.runtime.id}`));
  if (!satisfiesVersion(runtime.runtimeVersion, manifest.runtime.versionRange)) failures.push(readinessFailure("runtime_version_incompatible", "runtime.version", `requires ${manifest.runtime.versionRange}`));
  const supportedFeatures = new Set(runtime.supportedFeatures ?? []);
  for (const feature of manifest.runtime.requiredFeatures ?? []) {
    if (!supportedFeatures.has(feature)) failures.push(readinessFailure("runtime_feature_missing", `runtime.requiredFeatures.${feature}`, `runtime does not provide ${feature}`));
  }
  if (!runtime.supportedExecutionModes.includes(manifest.execution.mode)) failures.push(readinessFailure("execution_mode_unsupported", "execution.mode", `runtime does not support ${manifest.execution.mode}`));

  const trusted = runtime.trustedChecksums.some((entry) => entry.kind === manifest.kind && entry.id === manifest.id && entry.version === manifest.version && entry.checksum.toLowerCase() === manifest.checksum);
  if (!trusted) failures.push(readinessFailure("checksum_untrusted", "checksum", "package checksum is not trusted by this runtime"));

  const installed = runtime.installedPackages ?? [];
  for (const dependency of manifest.dependencies) {
    const candidate = installed.find((entry) => entry.kind === dependency.kind && entry.id === dependency.id);
    if (!candidate) {
      if (!dependency.optional) failures.push(readinessFailure("dependency_missing", `dependencies.${dependency.kind}:${dependency.id}`, `requires ${dependency.kind}:${dependency.id}@${dependency.versionRange}`, { dependency }));
      continue;
    }
    if (!satisfiesVersion(candidate.version, dependency.versionRange)) failures.push(readinessFailure("dependency_version_incompatible", `dependencies.${dependency.kind}:${dependency.id}`, `installed version ${candidate.version} does not satisfy ${dependency.versionRange}`, { dependency }));
    else if (candidate.ready === false) failures.push(readinessFailure("dependency_not_ready", `dependencies.${dependency.kind}:${dependency.id}`, "dependency is installed but not ready", { dependency }));
  }

  const grantedPermissions = new Set(runtime.grantedPermissions ?? []);
  for (const permission of manifest.permissions) {
    if (!grantedPermissions.has(permission)) failures.push(readinessFailure("permission_not_granted", `permissions.${permission}`, `permission ${permission} has not been granted`, { permission }));
  }

  const configuration = resolveConfiguration(manifest, runtime, failures);
  return freezeDeep({ status: failures.length ? "blocked" : "ready", ready: failures.length === 0, failures, configuration });
}

/** Validate first, then evaluate readiness without exposing partially parsed manifests. */
export function validateAndAssessExtensionPackage(
  input: unknown,
  runtime: ExtensionPackageRuntime,
): ExtensionPackageAssessmentResult {
  const validation = validateExtensionPackageManifest(input);
  if (!validation.ok) return { ok: false, phase: "validation", failures: validation.failures };
  return { ok: true, phase: "readiness", manifest: validation.manifest, readiness: assessExtensionPackageReadiness(validation.manifest, runtime) };
}
