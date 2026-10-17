import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest } from "./contracts";
import { transaction } from "./database";
import { actionMissing, requireActionMember, type ActionScope, type ConnectionStore } from "./connections";
import { capabilityBindingSchema, capabilityCatalogSchema, createBinding, resourceHandleSchema,
  type CapabilityBinding, type CapabilityCatalog, type ExecutableAdapterRegistry, type ResourceHandle } from "./capability-catalog";
import { githubOperationSchema } from "./github-adapter";

// Trusted provider policy; remote annotations or tool descriptions cannot add operations.
export const GITHUB_MCP_READ_OPERATIONS: ReadonlySet<string> = new Set([
  "get_file_contents", "get_repository_tree", "list_releases", "get_latest_release", "get_release_by_tag",
]);
export function githubProviderOperationAllowed(transport: string, operation: string): boolean {
  return transport === "native_http" ? githubOperationSchema.safeParse(operation).success : transport === "mcp_http" && GITHUB_MCP_READ_OPERATIONS.has(operation);
}
const selectionSchema = z.strictObject({ providerOperation: z.string().min(1).max(128), resources: z.array(resourceHandleSchema).min(1).max(20) });
export const selectCatalogBindingsSchema = z.strictObject({ operationId: z.string().min(1).max(128), connectionId: z.uuid(),
  expectedRevision: z.number().int().positive(), catalogId: z.uuid(), selections: z.array(selectionSchema).min(1).max(8)
    .refine(selections => new Set(selections.map(selection => selection.providerOperation)).size === selections.length, "Duplicate selected operation") });
export type SelectCatalogBindingsInput = z.infer<typeof selectCatalogBindingsSchema>;
export interface CatalogCandidateDTO { id: string; connectionId: string; credentialRevision: number; policyRevision: number; createdAt: string; selectableOperations: string[]; catalog: CapabilityCatalog }
function resourceKey(resource: ResourceHandle): string { return requestDigest(resource); }

export class ConnectedCatalogStore {
  constructor(readonly pool: Pool, readonly connections: ConnectionStore, private readonly registry: ExecutableAdapterRegistry<unknown>) {}
  private async lock(db: PoolClient, scope: ActionScope, id: string, expectedRevision?: number) {
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
    await requireActionMember(db, scope);
    const row = (await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 FOR UPDATE", [id, scope.organizationId, scope.accountId])).rows[0];
    if (!row) throw actionMissing();
    if (row.profile_id !== "github-public-read-v1") throw new PlatformError("CONNECTION_PROFILE_DENIED", 403, "Select a GitHub connection");
    if (row.state !== "active" || Date.parse(row.expires_at) <= Date.now()) throw new PlatformError("CONNECTION_INACTIVE", 403, "Connection authorization is unavailable");
    if (expectedRevision !== undefined && row.revision !== expectedRevision) throw new PlatformError("CONNECTION_REVISION_CONFLICT", 409, "Connection changed; refresh and try again");
    return row;
  }
  private dto(row: Record<string, any>): CatalogCandidateDTO {
    return { id: row.id, connectionId: row.connection_id, credentialRevision: row.credential_revision,
      policyRevision: row.policy_revision, createdAt: new Date(row.created_at).toISOString(),
      selectableOperations: row.catalog.tools.filter((tool: { providerOperation: string }) => githubProviderOperationAllowed(row.catalog.transport, tool.providerOperation)).map((tool: { providerOperation: string }) => tool.providerOperation),
      catalog: capabilityCatalogSchema.parse(row.catalog) };
  }
  private async replay(db: PoolClient, scope: ActionScope, operationId: string, digest: string): Promise<unknown> {
    const old = (await db.query("SELECT request_digest,result FROM agents_platform.capability_mutations WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3", [scope.organizationId, scope.accountId, operationId])).rows[0];
    if (old && old.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request identity conflict");
    return old?.result;
  }
  private async record(db: PoolClient, scope: ActionScope, operationId: string, digest: string, result: unknown): Promise<void> {
    await db.query("INSERT INTO agents_platform.capability_mutations(organization_id,account_id,operation_id,request_digest,result) VALUES($1,$2,$3,$4,$5)", [scope.organizationId, scope.accountId, operationId, digest, JSON.stringify(result)]);
  }
  /** Trusted discovery only: HTTP clients cannot upload a catalog or select adapter releases. */
  async saveCandidate(scope: ActionScope, input: { operationId: string; connectionId: string; expectedRevision: number; catalog: CapabilityCatalog }): Promise<CatalogCandidateDTO> {
    const parsed = z.strictObject({ operationId: z.string().min(1).max(128), connectionId: z.uuid(), expectedRevision: z.number().int().positive(), catalog: capabilityCatalogSchema }).parse(input);
    const digest = requestDigest({ kind: "catalog.discovered", ...parsed });
    return transaction(this.pool, async db => {
      const connection = await this.lock(db, scope, parsed.connectionId, parsed.expectedRevision);
      const prior = await this.replay(db, scope, parsed.operationId, digest);
      if (prior) return prior as CatalogCandidateDTO;
      const catalog = parsed.catalog;
      if (catalog.organizationId !== scope.organizationId || catalog.connectionId !== connection.id || !["native_http", "mcp_http"].includes(catalog.transport)) throw new PlatformError("CATALOG_SCOPE_DENIED", 403, "Catalog does not match the connection");
      this.registry.resolve(catalog);
      const nextRevision = Number((await db.query("SELECT COALESCE(MAX(revision),0)+1 AS revision FROM agents_platform.capability_catalogs WHERE connection_id=$1", [connection.id])).rows[0].revision);
      if (catalog.revision !== nextRevision) throw new PlatformError("CATALOG_REVISION_CONFLICT", 409, "Catalog revision changed during discovery");
      const row = (await db.query("INSERT INTO agents_platform.capability_catalogs(id,organization_id,connection_id,account_id,revision,credential_revision,policy_revision,digest,catalog) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", [catalog.id, scope.organizationId, connection.id, scope.accountId, catalog.revision, connection.revision, connection.policy_revision, catalog.digest, JSON.stringify(catalog)])).rows[0];
      const result = this.dto(row); await this.record(db, scope, parsed.operationId, digest, result); return result;
    });
  }
  async listCandidates(scope: ActionScope, connectionId: string): Promise<CatalogCandidateDTO[]> {
    z.uuid().parse(connectionId);
    return transaction(this.pool, async db => {
      await this.lock(db, scope, connectionId);
      return (await db.query("SELECT * FROM agents_platform.capability_catalogs WHERE connection_id=$1 AND organization_id=$2 AND account_id=$3 ORDER BY revision DESC", [connectionId, scope.organizationId, scope.accountId])).rows.map(row => this.dto(row));
    });
  }
  async selectBindings(scope: ActionScope, raw: SelectCatalogBindingsInput): Promise<CapabilityBinding[]> {
    const input = selectCatalogBindingsSchema.parse(raw), digest = requestDigest({ kind: "catalog.select", ...input });
    return transaction(this.pool, async db => {
      const connection = await this.lock(db, scope, input.connectionId, input.expectedRevision);
      const prior = await this.replay(db, scope, input.operationId, digest);
      if (prior) return z.array(capabilityBindingSchema).parse(prior);
      const row = (await db.query("SELECT * FROM agents_platform.capability_catalogs WHERE id=$1 AND connection_id=$2 AND organization_id=$3 AND account_id=$4 FOR SHARE", [input.catalogId, connection.id, scope.organizationId, scope.accountId])).rows[0];
      if (!row) throw actionMissing();
      if (row.credential_revision !== connection.revision || row.policy_revision !== connection.policy_revision) throw new PlatformError("CATALOG_CONNECTION_CHANGED", 409, "Rediscover tools after the connection changes");
      const catalog = capabilityCatalogSchema.parse(row.catalog); this.registry.resolve(catalog);
      const connectionResources = z.array(resourceHandleSchema).parse(connection.resource_handles);
      const bindings = input.selections.map(selection => {
        const definition = catalog.tools.find(tool => tool.providerOperation === selection.providerOperation);
        if (!definition || !githubProviderOperationAllowed(catalog.transport, selection.providerOperation)) throw new PlatformError("PROVIDER_OPERATION_DENIED", 403, "Operation is outside the approved read profile");
        if (new Set(selection.resources.map(resourceKey)).size !== selection.resources.length || selection.resources.some(resource => !connectionResources.some(approved => resourceKey(approved) === resourceKey(resource)))) throw new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "Selected resource is outside the connection scope");
        return createBinding({ schemaVersion: 1, id: randomUUID(), organizationId: scope.organizationId,
          catalog: { id: catalog.id, revision: catalog.revision, digest: catalog.digest }, definition, adapter: catalog.adapter,
          transport: catalog.transport, protocolVersion: catalog.protocolVersion,
          connection: { id: connection.id, profileId: connection.profile_id, policyRevision: connection.policy_revision },
          resources: selection.resources, policy: { effect: "read", disclosure: "public_identifiers", retry: "safe_read", approval: "none", cancel: "stop_admission" },
          limits: { timeoutMs: 30000, maxPhysicalAttempts: 3, maxResponseBytes: catalog.transport === "mcp_http" ? 262144 : 2097152, maxModelResultBytes: 8192 } }, catalog);
      });
      for (const binding of bindings) await db.query("INSERT INTO agents_platform.capability_bindings(id,organization_id,connection_id,catalog_id,account_id,alias,digest,binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [binding.id, scope.organizationId, connection.id, catalog.id, scope.accountId, binding.alias, binding.digest, JSON.stringify(binding)]);
      await this.record(db, scope, input.operationId, digest, bindings); return bindings;
    });
  }
  /** Management picker: connection status is returned separately; immutable selections remain visible after revoke. */
  async listBindings(scope: ActionScope): Promise<CapabilityBinding[]> {
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      return (await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND account_id=$2 ORDER BY created_at,id", [scope.organizationId, scope.accountId])).rows.map(row => capabilityBindingSchema.parse(row.binding));
    });
  }
  async getBindings(scope: ActionScope, ids: readonly string[]): Promise<CapabilityBinding[]> {
    z.array(z.uuid()).max(8).parse(ids);
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      const rows = (await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND account_id=$2 AND id=ANY($3::uuid[])", [scope.organizationId, scope.accountId, ids])).rows;
      const byId = new Map(rows.map(row => { const binding = capabilityBindingSchema.parse(row.binding); return [binding.id, binding]; }));
      if (ids.some(id => !byId.has(id))) throw actionMissing();
      return ids.map(id => byId.get(id)!);
    });
  }
}
