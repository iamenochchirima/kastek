import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { requestDigest } from "../src/platform/contracts";
import {
  adapterManifestSchema, assertCapabilityGrant, buildPublishedBindings, capabilityBindingSchema,
  capabilityCatalogSchema, createBinding, createCatalog, createModelAlias, digestToolSchema,
  ExecutableAdapterRegistry, intersectCapabilityGrants, preflightToolSchema, resolveModelAlias,
  routeCapabilityOperation, type AdapterManifest, type CapabilityBinding, type CapabilityGrant,
} from "../src/platform/capability-catalog";

const organizationId = randomUUID(), connectionId = randomUUID();
const manifest: AdapterManifest = { schemaVersion: 1, id: "provider-read", release: "1.0.0", executableDigest: "a".repeat(64),
  transports: ["native_http", "mcp_http"], protocolVersions: ["2026-07-28", "2025-11-25"], boundedSchemaValidation: true };
const executor = Object.freeze({ invoke: "actual-adapter-handler" });
function fixtures(names = ["repo.read"]) {
  const registry = new ExecutableAdapterRegistry<typeof executor>();
  const adapter = registry.register(manifest, executor);
  const inputSchema = { type: "object", properties: { repository: { type: "string", maxLength: 100 } }, required: ["repository"], additionalProperties: false };
  const catalog = createCatalog({ schemaVersion: 1, id: randomUUID(), organizationId, connectionId, revision: 1,
    transport: "mcp_http", protocolVersion: "2026-07-28", adapter,
    tools: names.map(providerOperation => ({ providerOperation, description: "Read an approved repository", inputSchema,
      outputSchema: null, inputDigest: digestToolSchema(inputSchema), outputDigest: null })) });
  const bindings = catalog.tools.map(definition => createBinding({ schemaVersion: 1, id: randomUUID(), organizationId,
    catalog: { id: catalog.id, revision: catalog.revision, digest: catalog.digest }, definition, adapter,
    transport: "mcp_http", protocolVersion: "2026-07-28", connection: { id: connectionId, profileId: "public-repository-read-v1", policyRevision: 1 },
    resources: [{ kind: "repository", id: "approved/repo" }], policy: { effect: "read", disclosure: "public_identifiers", retry: "safe_read", approval: "none", cancel: "stop_admission" },
    limits: { timeoutMs: 30000, maxPhysicalAttempts: 3, maxResponseBytes: 262144, maxModelResultBytes: 8192 },
  }, catalog));
  const binding = bindings[0]!;
  const grant: CapabilityGrant = { organizationId, principal: { kind: "automation", id: randomUUID(), ownerAccountId: randomUUID() },
    bindingIds: bindings.map(item => item.id), connections: [{ id: connectionId, policyRevision: 1, resources: [...binding.resources] }] };
  return { registry, adapter, catalog, bindings, binding, grant };
}

describe("immutable capability publication", () => {
  it("keeps ambiguous provider names and same-named tools separate with explicit aliases", () => {
    const { bindings } = fixtures(["repo.read", "repo_read", "repo-read"]);
    const otherServer = fixtures(["repo.read"]);
    const published = buildPublishedBindings([...bindings, otherServer.binding]);
    expect(new Set(published.map(binding => binding.alias)).size).toBe(4);
    for (const binding of published) expect(resolveModelAlias(published, binding.alias).definition.providerOperation).toBe(binding.definition.providerOperation);
    for (const invented of ["repo_read", "repo.read", "t_" + "0".repeat(32)]) expect(() => resolveModelAlias(published, invented)).toThrowError(expect.objectContaining({ code: "TOOL_ALIAS_UNAVAILABLE" }));
    expect(() => buildPublishedBindings([...bindings, bindings[0]!])).toThrowError(expect.objectContaining({ code: "DUPLICATE_TOOL_ALIAS" }));
  });

  it("pins exact schema content and defensively freezes published revisions", () => {
    const { catalog, binding } = fixtures();
    expect(digestToolSchema({ type: "object", properties: { b: { type: "number" }, a: { type: "string" } } }))
      .toBe(digestToolSchema({ properties: { a: { type: "string" }, b: { type: "number" } }, type: "object" }));
    expect(Object.isFrozen(binding.definition.inputSchema)).toBe(true);
    expect(() => { binding.resources[0]!.id = "another/repo"; }).toThrow();
    const tampered = structuredClone(catalog);
    tampered.tools[0]!.inputSchema = { type: "object", additionalProperties: true };
    const { digest: _, ...content } = tampered;
    expect(capabilityCatalogSchema.safeParse({ ...content, digest: requestDigest(content) }).success).toBe(false);
    expect(capabilityBindingSchema.safeParse({ ...binding, adapter: { ...binding.adapter, release: "latest" } }).success).toBe(false);
    expect(capabilityBindingSchema.safeParse({ ...binding, alias: createModelAlias(randomUUID()) }).success).toBe(false);
  });

  it("refuses publication against another catalog or undiscovered definition", () => {
    const { binding, catalog } = fixtures();
    const { digest: _, alias: __, ...input } = binding;
    expect(() => createBinding({ ...input, definition: { ...input.definition, providerOperation: "write.hidden" } }, catalog))
      .toThrowError(expect.objectContaining({ code: "CATALOG_BINDING_MISMATCH" }));
    expect(() => createBinding(input, fixtures().catalog)).toThrowError(expect.objectContaining({ code: "CATALOG_BINDING_MISMATCH" }));
    const write = { ...input, policy: { effect: "reviewed_write", approval: "exact_single_use", retry: "status_only", disclosure: "exact_reviewed_payload", cancel: "reconcile_claimed" } } as typeof input;
    expect(() => createBinding(write, catalog)).toThrow("read-only");
  });

  it("keeps private Stash item disclosure distinct from public GitHub identifiers",()=>{
    const f=fixtures(["get_item"]), {digest,alias,...input}=f.binding;
    const stash={...input,connection:{id:connectionId,profileId:"stash-read-v1",policyRevision:1},resources:[{kind:"stash.item",id:randomUUID()}],
      policy:{...input.policy,disclosure:"approved_resource_identifiers" as const}};
    expect(createBinding(stash,f.catalog).policy.disclosure).toBe("approved_resource_identifiers");
    expect(()=>createBinding({...stash,policy:{...stash.policy,disclosure:"public_identifiers"}},f.catalog)).toThrow("read-only");
    expect(()=>createBinding({...stash,resources:[{kind:"github.repository",id:"approved/repo"}]},f.catalog)).toThrow("Stash");
    const wrong=fixtures(["update_item"]),{digest:otherDigest,alias:otherAlias,...wrongInput}=wrong.binding;
    expect(()=>createBinding({...wrongInput,connection:stash.connection,resources:stash.resources,policy:stash.policy},wrong.catalog)).toThrow("Stash");
    expect(()=>createBinding({...input,connection:{id:connectionId,profileId:"github-public-read-v1",policyRevision:1},policy:stash.policy},f.catalog)).toThrow("read-only");
  });

  it("rejects entire oversized or duplicate discovery rather than silently selecting tools", () => {
    expect(() => fixtures(Array.from({ length: 101 }, (_, i) => `read${i}`))).toThrow();
    expect(() => fixtures(["read", "read"])).toThrow("Duplicate provider operation");
    const { catalog } = fixtures(Array.from({ length: 100 }, (_, i) => `read${i}`));
    const { digest: _, ...content } = catalog;
    expect(() => createCatalog({ ...content, tools: content.tools.map(tool => ({ ...tool, description: "x".repeat(4096) })) })).toThrow("Catalog exceeds byte limit");
    expect(() => buildPublishedBindings(Array.from({ length: 9 }, () => fixtures().binding))).toThrow("Too many");
  });

  it("supports pinned builtins without granting connection authority", () => {
    const { catalog, adapter } = fixtures();
    const { digest: oldDigest, ...catalogContent } = catalog;
    const builtin = createCatalog({ ...catalogContent, id: randomUUID(), connectionId: null, transport: "builtin", protocolVersion: null });
    const { digest: oldBindingDigest, alias: oldAlias, ...source } = fixtures().binding;
    const binding = createBinding({ ...source, id: randomUUID(), catalog: { id: builtin.id, revision: builtin.revision, digest: builtin.digest },
      definition: builtin.tools[0]!, adapter, transport: "builtin", protocolVersion: null, connection: null,
      resources: [], policy: { effect: "resource", disclosure: "none", retry: "adapter_reconcile", approval: "none", cancel: "adapter_cleanup" },
      limits: { ...source.limits, timeoutMs: 240000 } }, builtin);
    expect(binding.connection).toBeNull();
  });
});

describe("bounded schema preflight", () => {
  it("accepts the bounded Stash draft-07 UUID subset and refuses other formats",()=>{
    expect(()=>preflightToolSchema({$schema:"http://json-schema.org/draft-07/schema#",type:"object",properties:{id:{type:"string",format:"uuid"}},required:["id"],additionalProperties:false})).not.toThrow();
    for(const unsupported of [{type:"array",prefixItems:[{type:"string"}]},{type:"object",$defs:{id:{type:"string"}}}]) expect(()=>preflightToolSchema({$schema:"http://json-schema.org/draft-07/schema#",...unsupported})).toThrow("Unsupported keyword in draft-07");
    expect(()=>preflightToolSchema({type:"object",properties:{id:{$schema:"http://json-schema.org/draft-07/schema#",type:"string"}}})).toThrow("Nested schema dialects");
    expect(()=>preflightToolSchema({type:"string",format:"uri"})).toThrow("Only UUID");
    expect(()=>preflightToolSchema({type:"string",format:"uuid",pattern:".*"})).toThrow("Unsupported schema keyword");
  });

  it("supports acyclic local definitions and ordinary data containing keyword names", () => {
    expect(() => preflightToolSchema({ type: "object", $defs: { name: { type: "string" }, allowed: true }, properties: { name: { $ref: "#/$defs/name" }, extra: { $ref: "#/$defs/allowed" } },
      examples: [{ pattern: "metadata is data" }], additionalProperties: false })).not.toThrow();
  });

  it("rejects recursive, remote, unsupported and pathological schema structures before SDK registration", () => {
    const cycle: Record<string, unknown> = { type: "object" }; cycle.properties = { self: cycle };
    const accessor = Object.defineProperty({}, "type", { enumerable: true, get() { throw new Error("Getter was executed"); } });
    const invalid = [cycle, accessor, { type: "invalid" }, { type: "object", required: [1] }, { type: "number", maximum: "10" }, { type: "array", maxItems: -1 }, { type: "string", pattern: "(a+)+$" }, { type: "string", format: "remote-validator" },
      { $ref: "https://attacker.example/schema" }, { $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, type: "object" },
      { type: "object", $defs: { node: { type: "object", properties: { self: { $ref: "#/$defs/node" } } } } },
      { type: "object", properties: { x: { $ref: "#/$defs/missing" } } }, { type: "object", description: "x".repeat(32769) },
      { type: "object", enum: Array.from({ length: 4096 }, () => 1) },
    ];
    for (const schema of invalid) expect(() => preflightToolSchema(schema)).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_TOOL_SCHEMA" }));
    let deep: unknown = { type: "string" };
    for (let i = 0; i < 20; i++) deep = { type: "object", properties: { next: deep } };
    expect(() => preflightToolSchema(deep)).toThrow("structural limits");
  });
});

describe("exact executable routing and replay", () => {
  it("requires the exact registered executable release and protocol", () => {
    const { registry, binding, adapter } = fixtures();
    expect(registry.resolve(binding)).toBe(executor);
    expect(registry.register(manifest, executor)).toEqual(adapter);
    expect(() => registry.register({ ...manifest, executableDigest: "b".repeat(64) }, executor)).toThrowError(expect.objectContaining({ code: "ADAPTER_RELEASE_CONFLICT" }));
    for (const changed of [{ release: "2.0.0" }, { manifestDigest: "b".repeat(64) }]) expect(() => registry.resolve({ ...binding, adapter: { ...binding.adapter, ...changed } })).toThrowError(expect.objectContaining({ code: "ADAPTER_RELEASE_UNAVAILABLE" }));
    expect(adapterManifestSchema.safeParse({ ...manifest, boundedSchemaValidation: false }).success).toBe(false);
  });

  it("replays a completed old-catalog operation without resolving changed or missing executors", () => {
    const { binding } = fixtures();
    const empty = new ExecutableAdapterRegistry<unknown>();
    const receipt = { bindingDigest: binding.digest, requestDigest: "d".repeat(64), state: "completed" as const, result: { value: "recorded" } };
    expect(routeCapabilityOperation(binding, { requestDigest: receipt.requestDigest, started: true, receipt }, empty)).toEqual({ kind: "recorded", receipt });
    expect(() => routeCapabilityOperation(binding, { requestDigest: "e".repeat(64), started: true, receipt }, empty)).toThrowError(expect.objectContaining({ code: "OPERATION_BINDING_CONFLICT" }));
    expect(() => routeCapabilityOperation(binding, { requestDigest: receipt.requestDigest, started: false }, empty)).toThrowError(expect.objectContaining({ code: "ADAPTER_RELEASE_UNAVAILABLE" }));
  });

  it("distinguishes safe reads, status reconciliation and unresolved uncertainty", () => {
    const { registry, binding } = fixtures();
    expect(routeCapabilityOperation(binding, { requestDigest: "d".repeat(64), started: false }, registry)).toMatchObject({ kind: "invoke", requiresCurrentAuthority: true });
    expect(routeCapabilityOperation(binding, { requestDigest: "d".repeat(64), started: true }, registry)).toMatchObject({ kind: "retry_read", requiresCurrentAuthority: true });
    const write = { ...binding, policy: { ...binding.policy, retry: "status_only" } } as CapabilityBinding;
    expect(routeCapabilityOperation(write, { requestDigest: "d".repeat(64), started: true }, registry)).toMatchObject({ kind: "reconcile", requiresCurrentAuthority: false, maySend: false });
    expect(routeCapabilityOperation({ ...write, policy: { ...write.policy, retry: "never" } }, { requestDigest: "d".repeat(64), started: true }, new ExecutableAdapterRegistry())).toEqual({ kind: "uncertain" });
  });
});

describe("capability authority intersections", () => {
  it("narrows specialist/automation scope to common exact resources and pinned policy revision", () => {
    const { binding, grant } = fixtures();
    const broad = { ...grant, bindingIds: [...grant.bindingIds, randomUUID()], connections: [{ ...grant.connections[0]!, resources: [...binding.resources, { kind: "repository", id: "private/repo" }] }] };
    const effective = intersectCapabilityGrants(broad, grant);
    expect(effective).toEqual(grant);
    expect(() => assertCapabilityGrant(binding, effective, binding.resources)).not.toThrow();
    for (const resources of [[], [{ kind: "repository", id: "private/repo" }], [{ kind: "url", id: "https://public.example/?leak=private" }]]) expect(() => assertCapabilityGrant(binding, effective, resources)).toThrowError(expect.objectContaining({ code: "CAPABILITY_SCOPE_DENIED" }));
    const revoked = intersectCapabilityGrants(grant, { ...grant, connections: [{ ...grant.connections[0]!, policyRevision: 2 }] });
    expect(revoked.connections).toEqual([]);
    expect(() => assertCapabilityGrant(binding, revoked, binding.resources)).toThrow("authorized scope");
  });

  it("never merges different principals, organizations or unauthorized binding identities", () => {
    const { binding, grant } = fixtures();
    expect(() => intersectCapabilityGrants()).toThrow();
    for (const changed of [{ organizationId: randomUUID() }, { principal: { ...grant.principal, id: randomUUID() } }]) expect(() => intersectCapabilityGrants(grant, { ...grant, ...changed } as CapabilityGrant)).toThrow("authorized scope");
    expect(() => assertCapabilityGrant(binding, { ...grant, bindingIds: [] }, binding.resources)).toThrow("authorized scope");
    expect(intersectCapabilityGrants(grant, { ...grant, bindingIds: [] }).bindingIds).toEqual([]);
  });
});
