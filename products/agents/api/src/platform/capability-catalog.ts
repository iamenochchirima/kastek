import { z } from "zod";
import { canonicalJson, PlatformError, principalSchema, requestDigest } from "./contracts";

export const capabilityLimits = Object.freeze({
  maxCatalogTools: 100, maxCatalogBytes: 262144, maxSchemaBytes: 32768, maxSchemaDepth: 16,
  maxSchemaNodes: 4096, maxPublishedBindings: 8, maxModelResultBytes: 8192,
});
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type ToolSchema = boolean | { [key: string]: JsonValue };
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().min(1).max(128);
export const capabilityTransportSchema = z.enum(["builtin", "native_http", "mcp_http"]);
export const adapterReferenceSchema = z.strictObject({ id: identifierSchema, release: identifierSchema, manifestDigest: digestSchema });
export const resourceHandleSchema = z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(4096) });
export type ResourceHandle = z.infer<typeof resourceHandleSchema>;

function invalidSchema(message: string): never { throw new PlatformError("UNSUPPORTED_TOOL_SCHEMA", 400, message); }

/** Structural preflight only. Compilation and instance validation belong in the bounded adapter process. */
export function preflightToolSchema(input: unknown): ToolSchema {
  let nodes = 0;
  const ancestors = new Set<object>();
  function json(value: unknown, depth: number): JsonValue {
    if (++nodes > capabilityLimits.maxSchemaNodes || depth > capabilityLimits.maxSchemaDepth) invalidSchema("Tool schema exceeds structural limits");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && Buffer.byteLength(value) <= capabilityLimits.maxSchemaBytes) return value;
    if (typeof value !== "object" || value === null || ancestors.has(value)) invalidSchema("Tool schema must be bounded JSON");
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalidSchema("Tool schema must contain plain JSON objects");
    ancestors.add(value);
    let result: JsonValue;
    if (Array.isArray(value)) result = value.map(item => json(item, depth + 1));
    else {
      const entries = Object.getOwnPropertyDescriptors(value);
      result = Object.create(null) as Record<string, JsonValue>;
      for (const [key, descriptor] of Object.entries(entries)) {
        if (!descriptor.enumerable || !("value" in descriptor) || Buffer.byteLength(key) > 1024) invalidSchema("Tool schema must contain plain JSON properties");
        (result as Record<string, JsonValue>)[key] = json(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(value);
    return result;
  }
  const copied = json(input, 0);
  if (Buffer.byteLength(canonicalJson(copied)) > capabilityLimits.maxSchemaBytes) invalidSchema("Tool schema exceeds byte limit");
  const draft07 = typeof copied === "object" && copied !== null && !Array.isArray(copied) && copied.$schema === "http://json-schema.org/draft-07/schema#";
  const keywords = new Set(["$schema", "$ref", "format", "title", "description", "type", "enum", "const", "default", "examples", "required", "additionalProperties", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "properties", "$defs", "items", "prefixItems", "allOf", "anyOf", "oneOf", "not"]);
  const schemaTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  const schemaNodes = new Set<string>();
  const children = new Map<string, string[]>();
  const refs = new Map<string, string>();
  function schema(value: JsonValue | undefined, pointer: string, parent?: string): void {
    schemaNodes.add(pointer);
    if (parent !== undefined) children.set(parent, [...(children.get(parent) ?? []), pointer]);
    if (typeof value === "boolean") return;
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidSchema("Expected a JSON Schema object or boolean");
    for (const [key, child] of Object.entries(value)) {
      if (key === "$schema" && pointer !== "") invalidSchema("Nested schema dialects are unsupported");
      if (draft07 && ["$defs", "prefixItems"].includes(key)) invalidSchema("Unsupported keyword in draft-07 schema");
      if (!keywords.has(key)) invalidSchema(`Unsupported schema keyword: ${key}`);
      if (["title", "description"].includes(key) && typeof child !== "string") invalidSchema("Expected a schema annotation string");
      if (key === "type" && !(typeof child === "string" ? schemaTypes.has(child) : Array.isArray(child) && child.length > 0 && child.every(type => typeof type === "string" && schemaTypes.has(type)) && new Set(child).size === child.length)) invalidSchema("Unsupported schema type");
      if (["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"].includes(key) && !(typeof child === "number" && Number.isSafeInteger(child) && child >= 0)) invalidSchema("Expected a nonnegative integer schema bound");
      if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].includes(key) && !(typeof child === "number" && (key !== "multipleOf" || child > 0))) invalidSchema("Expected a numeric schema bound");
      if (key === "uniqueItems" && typeof child !== "boolean") invalidSchema("Expected a boolean schema bound");
      if (["required", "enum", "examples"].includes(key) && !Array.isArray(child)) invalidSchema("Expected a schema array");
      if (key === "required" && Array.isArray(child) && (child.some(item => typeof item !== "string") || new Set(child).size !== child.length)) invalidSchema("Expected unique required property names");
      if (key === "enum" && Array.isArray(child) && (child.length === 0 || new Set(child.map(canonicalJson)).size !== child.length)) invalidSchema("Expected unique enum values");
      if (key === "format" && child !== "uuid") invalidSchema("Only UUID schema format is supported");
      if (key === "$schema" && !["https://json-schema.org/draft/2020-12/schema", "http://json-schema.org/draft-07/schema#"].includes(child as string)) invalidSchema("Unsupported JSON Schema dialect");
      if (key === "$ref") {
        if (typeof child !== "string" || !child.startsWith("#/$defs/")) invalidSchema("Only local definition references are supported");
        refs.set(pointer, child.slice(1));
      }
      if (key === "properties" || key === "$defs") {
        if (!child || typeof child !== "object" || Array.isArray(child)) invalidSchema("Expected a schema map");
        for (const [name, definition] of Object.entries(child)) schema(definition, `${pointer}/${key}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`, pointer);
      }
      if (["items", "additionalProperties", "not"].includes(key)) schema(child, `${pointer}/${key}`, pointer);
      if (["prefixItems", "allOf", "anyOf", "oneOf"].includes(key)) {
        if (!Array.isArray(child)) invalidSchema("Expected a schema array");
        child.forEach((definition, index) => schema(definition, `${pointer}/${key}/${index}`, pointer));
      }
    }
  }
  schema(copied, "");
  // Include containment edges: a reference back to an enclosing definition is recursive too.
  function acyclic(pointer: string, visiting: Set<string>, visited: Set<string>): void {
    if (visiting.has(pointer)) invalidSchema("Recursive schema references are unsupported");
    if (visited.has(pointer)) return;
    visiting.add(pointer);
    const target = refs.get(pointer);
    if (target !== undefined) {
      if (!schemaNodes.has(target)) invalidSchema("Unknown local schema reference");
      acyclic(target, visiting, visited);
    }
    for (const child of children.get(pointer) ?? []) acyclic(child, visiting, visited);
    visiting.delete(pointer); visited.add(pointer);
  }
  acyclic("", new Set(), new Set());
  return copied as ToolSchema;
}

const toolSchema = z.unknown().transform((input, ctx): ToolSchema => {
  try { return preflightToolSchema(input); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid tool schema" }); return z.NEVER; }
});
export function digestToolSchema(input: unknown): string { return requestDigest(preflightToolSchema(input)); }

export const catalogToolSchema = z.strictObject({
  providerOperation: identifierSchema, description: z.string().max(4096),
  inputSchema: toolSchema, outputSchema: toolSchema.nullable(), inputDigest: digestSchema, outputDigest: digestSchema.nullable(),
}).superRefine((value, ctx) => {
  if (requestDigest(value.inputSchema) !== value.inputDigest || (value.outputSchema === null ? value.outputDigest !== null : requestDigest(value.outputSchema) !== value.outputDigest)) ctx.addIssue({ code: "custom", message: "Tool schema digest mismatch" });
  if (typeof value.inputSchema !== "object" || value.inputSchema.type !== "object") ctx.addIssue({ code: "custom", message: "Tool input schema must be an object schema" });
});

const catalogFields = {
  schemaVersion: z.literal(1), id: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid().nullable(), revision: z.number().int().positive(),
  transport: capabilityTransportSchema, protocolVersion: z.enum(["2026-07-28", "2025-11-25"]).nullable(), adapter: adapterReferenceSchema,
  tools: z.array(catalogToolSchema).max(capabilityLimits.maxCatalogTools), digest: digestSchema,
};
function transportIssue(value: { transport: string; connectionId: string | null; protocolVersion: string | null }): boolean {
  return (value.transport === "builtin") !== (value.connectionId === null) || (value.transport === "mcp_http") !== (value.protocolVersion !== null);
}
export const capabilityCatalogSchema = z.strictObject(catalogFields).superRefine((value, ctx) => {
  const { digest, ...content } = value;
  if (digest !== requestDigest(content)) ctx.addIssue({ code: "custom", message: "Catalog digest mismatch" });
  if (transportIssue(value)) ctx.addIssue({ code: "custom", message: "Invalid transport connection or protocol" });
  if (new Set(value.tools.map(tool => tool.providerOperation)).size !== value.tools.length) ctx.addIssue({ code: "custom", message: "Duplicate provider operation" });
  if (Buffer.byteLength(canonicalJson(value)) > capabilityLimits.maxCatalogBytes) ctx.addIssue({ code: "custom", message: "Catalog exceeds byte limit" });
});
export type CapabilityCatalog = z.infer<typeof capabilityCatalogSchema>;

export const stashReadOperationSchema = z.enum(["get_item", "read_project_document"]);

export const capabilityPolicySchema = z.strictObject({
  effect: z.enum(["read", "reviewed_write", "idempotent_memory", "delegation", "resource"]),
  disclosure: z.enum(["none", "public_identifiers", "approved_resource_identifiers", "exact_reviewed_payload"]),
  retry: z.enum(["safe_read", "status_only", "idempotent_receipt", "stable_children", "adapter_reconcile", "never"]),
  approval: z.enum(["none", "exact_single_use"]), cancel: z.enum(["stop_admission", "dependent_children", "adapter_cleanup", "reconcile_claimed"]),
}).superRefine((policy, ctx) => {
  if (policy.effect === "reviewed_write" && (policy.approval !== "exact_single_use" || policy.retry !== "status_only" || policy.disclosure !== "exact_reviewed_payload" || policy.cancel !== "reconcile_claimed")) ctx.addIssue({ code: "custom", message: "Writes require exact review and status-only recovery" });
  if (policy.retry === "safe_read" && policy.effect !== "read") ctx.addIssue({ code: "custom", message: "Only reads may use safe-read retry" });
});
const bindingFields = {
  schemaVersion: z.literal(1), id: z.uuid(), organizationId: z.uuid(), alias: z.string().regex(/^t_[a-f0-9]{32}$/),
  catalog: z.strictObject({ id: z.uuid(), revision: z.number().int().positive(), digest: digestSchema }),
  definition: catalogToolSchema, adapter: adapterReferenceSchema, transport: capabilityTransportSchema,
  protocolVersion: z.enum(["2026-07-28", "2025-11-25"]).nullable(),
  connection: z.strictObject({ id: z.uuid(), profileId: identifierSchema, policyRevision: z.number().int().positive() }).nullable(),
  resources: z.array(resourceHandleSchema).max(100), policy: capabilityPolicySchema,
  limits: z.strictObject({ timeoutMs: z.number().int().min(1).max(240000), maxPhysicalAttempts: z.number().int().min(1).max(3),
    maxResponseBytes: z.number().int().min(1).max(2097152), maxModelResultBytes: z.number().int().min(1).max(capabilityLimits.maxModelResultBytes) }),
  digest: digestSchema,
};
export const capabilityBindingSchema = z.strictObject(bindingFields).superRefine((binding, ctx) => {
  const { digest, ...content } = binding;
  if (digest !== requestDigest(content)) ctx.addIssue({ code: "custom", message: "Binding digest mismatch" });
  if (binding.alias !== createModelAlias(binding.id)) ctx.addIssue({ code: "custom", message: "Alias must match the immutable binding identity" });
  if (transportIssue({ ...binding, connectionId: binding.connection?.id ?? null })) ctx.addIssue({ code: "custom", message: "Invalid transport connection or protocol" });
  if (new Set(binding.resources.map(resourceKey)).size !== binding.resources.length) ctx.addIssue({ code: "custom", message: "Duplicate resource handle" });
  const stash = binding.connection?.profileId === "stash-read-v1";
  if(stash && (binding.transport !== "mcp_http" || !stashReadOperationSchema.safeParse(binding.definition.providerOperation).success || binding.resources.some(resource=>resource.kind !== "stash.item" || !z.uuid().safeParse(resource.id).success))) ctx.addIssue({code:"custom",message:"Stash bindings require approved item handles over MCP"});
  if (binding.transport !== "builtin" && (binding.policy.effect !== "read" || binding.policy.retry !== "safe_read" || binding.policy.approval !== "none" || binding.policy.disclosure !== (stash ? "approved_resource_identifiers" : "public_identifiers") || binding.resources.length === 0 || binding.limits.timeoutMs > 30000 || (binding.transport === "mcp_http" && binding.limits.maxResponseBytes > 262144))) ctx.addIssue({ code: "custom", message: "Connected bindings must satisfy the read-only connection profile" });
});
export type CapabilityBinding = z.infer<typeof capabilityBindingSchema>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function createModelAlias(bindingId: string): string { return `t_${z.uuid().parse(bindingId).replaceAll("-", "").toLowerCase()}`; }
export function createCatalog(input: Omit<CapabilityCatalog, "digest">): CapabilityCatalog {
  const content = z.strictObject(catalogFields).omit({ digest: true }).parse(input);
  return freeze(capabilityCatalogSchema.parse({ ...content, digest: requestDigest(content) }));
}
export function createBinding(input: Omit<CapabilityBinding, "digest" | "alias">, catalog: CapabilityCatalog): CapabilityBinding {
  input = z.strictObject(bindingFields).omit({ digest: true, alias: true }).parse(input);
  const pinned = capabilityCatalogSchema.parse(catalog);
  if (input.organizationId !== pinned.organizationId || input.catalog.id !== pinned.id || input.catalog.revision !== pinned.revision || input.catalog.digest !== pinned.digest || input.transport !== pinned.transport || input.protocolVersion !== pinned.protocolVersion || canonicalJson(input.adapter) !== canonicalJson(pinned.adapter) || (input.connection?.id ?? null) !== pinned.connectionId || !pinned.tools.some(tool => canonicalJson(tool) === canonicalJson(input.definition))) throw new PlatformError("CATALOG_BINDING_MISMATCH", 409, "Binding does not match the approved catalog revision");
  const content = { ...input, alias: createModelAlias(input.id) };
  return freeze(capabilityBindingSchema.parse({ ...content, digest: requestDigest(content) }));
}
export function buildPublishedBindings(bindings: readonly CapabilityBinding[]): readonly CapabilityBinding[] {
  if (bindings.filter(binding => binding.transport !== "builtin").length > capabilityLimits.maxPublishedBindings || bindings.length > capabilityLimits.maxPublishedBindings + 16) throw new PlatformError("CAPABILITY_LIMIT", 400, "Too many connected tool bindings");
  const parsed = bindings.map(binding => capabilityBindingSchema.parse(binding));
  if (new Set(parsed.map(binding => binding.organizationId)).size > 1) throw new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "Published tools must belong to one organization");
  if (new Set(parsed.map(binding => binding.alias)).size !== parsed.length) throw new PlatformError("DUPLICATE_TOOL_ALIAS", 400, "Duplicate tool alias");
  return freeze(parsed);
}
export function resolveModelAlias(bindings: readonly CapabilityBinding[], alias: string): CapabilityBinding {
  const binding = bindings.find(candidate => candidate.alias === alias);
  if (!binding) throw new PlatformError("TOOL_ALIAS_UNAVAILABLE", 403, "Model tool alias is not published");
  return binding;
}

export const adapterManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), id: identifierSchema, release: identifierSchema, executableDigest: digestSchema,
  transports: z.array(capabilityTransportSchema).min(1).max(3),
  protocolVersions: z.array(z.enum(["2026-07-28", "2025-11-25"])).max(2),
  boundedSchemaValidation: z.literal(true),
});
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;
/** Registrations supply real executors. Persisted manifests alone do not make a release executable. */
export class ExecutableAdapterRegistry<TExecutor> {
  private readonly releases = new Map<string, { reference: z.infer<typeof adapterReferenceSchema>; manifest: AdapterManifest; executor: TExecutor }>();
  register(manifest: AdapterManifest, executor: TExecutor): z.infer<typeof adapterReferenceSchema> {
    if (executor === null || executor === undefined) throw new PlatformError("ADAPTER_RELEASE_UNAVAILABLE", 503, "Executable adapter registration requires a handler");
    const parsed = freeze(adapterManifestSchema.parse(manifest));
    const reference = freeze({ id: parsed.id, release: parsed.release, manifestDigest: requestDigest(parsed) });
    const key = canonicalJson([parsed.id, parsed.release]);
    const existing = this.releases.get(key);
    if (existing && (existing.reference.manifestDigest !== reference.manifestDigest || existing.executor !== executor)) throw new PlatformError("ADAPTER_RELEASE_CONFLICT", 409, "Adapter release is already registered differently");
    if (!existing) this.releases.set(key, { reference, manifest: parsed, executor });
    return reference;
  }
  resolve(binding: Pick<CapabilityBinding, "adapter" | "transport" | "protocolVersion">): TExecutor {
    const entry = this.releases.get(canonicalJson([binding.adapter.id, binding.adapter.release]));
    if (!entry || entry.reference.manifestDigest !== binding.adapter.manifestDigest || !entry.manifest.transports.includes(binding.transport) || (binding.protocolVersion !== null && !entry.manifest.protocolVersions.includes(binding.protocolVersion))) throw new PlatformError("ADAPTER_RELEASE_UNAVAILABLE", 503, "The pinned executable adapter release is unavailable");
    return entry.executor;
  }
}

export const capabilityGrantSchema = z.strictObject({
  organizationId: z.uuid(), principal: principalSchema, bindingIds: z.array(z.uuid()).max(100).refine(ids => new Set(ids).size === ids.length, "Duplicate binding grant"),
  connections: z.array(z.strictObject({ id: z.uuid(), policyRevision: z.number().int().positive(), resources: z.array(resourceHandleSchema).max(100)
    .refine(resources => new Set(resources.map(resourceKey)).size === resources.length, "Duplicate resource grant") })).max(20)
    .refine(connections => new Set(connections.map(connection => connection.id)).size === connections.length, "Duplicate connection grant"),
});
export type CapabilityGrant = z.infer<typeof capabilityGrantSchema>;
function resourceKey(resource: ResourceHandle): string { return canonicalJson([resource.kind, resource.id]); }
function denied(): never { throw new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "Capability exceeds the current authorized scope"); }
/** Every argument is an authority ceiling. The result grants only their common exact handles. */
export function intersectCapabilityGrants(...inputs: CapabilityGrant[]): CapabilityGrant {
  if (inputs.length === 0) denied();
  const grants = inputs.map(input => capabilityGrantSchema.parse(input));
  const first = grants[0]!;
  if (grants.some(grant => grant.organizationId !== first.organizationId || canonicalJson(grant.principal) !== canonicalJson(first.principal))) denied();
  const bindingIds = [...new Set(first.bindingIds)].filter(id => grants.every(grant => grant.bindingIds.includes(id)));
  const connections = first.connections.flatMap(connection => {
    const matches = grants.map(grant => grant.connections.find(candidate => candidate.id === connection.id && candidate.policyRevision === connection.policyRevision));
    if (matches.some(match => !match)) return [];
    return [{ ...connection, resources: connection.resources.filter(resource => matches.every(match => match!.resources.some(candidate => resourceKey(candidate) === resourceKey(resource)))) }];
  });
  return freeze({ organizationId: first.organizationId, principal: first.principal, bindingIds, connections });
}
export function assertCapabilityGrant(binding: CapabilityBinding, grant: CapabilityGrant, requested: readonly ResourceHandle[]): void {
  const parsed = capabilityGrantSchema.parse(grant);
  if (binding.organizationId !== parsed.organizationId || !parsed.bindingIds.includes(binding.id)) denied();
  if (binding.connection === null) { if (requested.some(resource => !binding.resources.some(candidate => resourceKey(candidate) === resourceKey(resource)))) denied(); return; }
  const connection = parsed.connections.find(candidate => candidate.id === binding.connection!.id && candidate.policyRevision === binding.connection!.policyRevision);
  if (!connection || requested.length === 0 || requested.some(resource => !binding.resources.some(candidate => resourceKey(candidate) === resourceKey(resource)) || !connection.resources.some(candidate => resourceKey(candidate) === resourceKey(resource)))) denied();
}

export type CapabilityReceipt = { bindingDigest: string; requestDigest: string; state: "completed" | "failed" | "uncertain"; result: JsonValue };
export type CapabilityReplayRoute<TExecutor> = { kind: "recorded"; receipt: CapabilityReceipt }
  | { kind: "invoke" | "retry_read"; executor: TExecutor; requiresCurrentAuthority: true }
  | { kind: "reconcile"; executor: TExecutor; requiresCurrentAuthority: boolean; maySend: false }
  | { kind: "uncertain" };
/** Recorded receipts must be consumed before resolving live registry code or performing new IO. */
export function routeCapabilityOperation<TExecutor>(binding: CapabilityBinding, input: { requestDigest: string; started: boolean; receipt?: CapabilityReceipt }, registry: ExecutableAdapterRegistry<TExecutor>): CapabilityReplayRoute<TExecutor> {
  digestSchema.parse(input.requestDigest);
  if (input.receipt) {
    if (input.receipt.bindingDigest !== binding.digest || input.receipt.requestDigest !== input.requestDigest) throw new PlatformError("OPERATION_BINDING_CONFLICT", 409, "Recorded operation identity differs");
    return { kind: "recorded", receipt: input.receipt };
  }
  if (input.started && binding.policy.retry === "never") return { kind: "uncertain" };
  const executor = registry.resolve(binding);
  if (!input.started) return { kind: "invoke", executor, requiresCurrentAuthority: true };
  if (binding.policy.retry === "safe_read") return { kind: "retry_read", executor, requiresCurrentAuthority: true };
  // A claimed external effect still needs a truthful receipt after revocation or root expiry.
  return { kind: "reconcile", executor, requiresCurrentAuthority: binding.policy.retry !== "status_only", maySend: false };
}
