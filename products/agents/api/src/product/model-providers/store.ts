import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { builtinProviderRegistry, getProviderDefinition } from "../../adapters/models/registry";
import { discoverProviderModels, ModelDiscoveryError, type ModelDiscoveryFetch, type ModelDiscoveryResult } from "../../adapters/models/discovery";
import type { ActionScope } from "../../contracts/connections";
import { canonicalJson, PlatformError, requestDigest } from "../../contracts/contracts";
import { modelEndpointSchema, providerConnectionSchema, providerDefinitionSchema, providerUseGrantSchema,
  resolvedModelBindingSchema, type ProviderConnection, type ProviderDefinition, type ProviderUseGrant, type ResolvedModelBinding } from "../../contracts/model-providers";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ModelCredentialVault, modelApiKeySchema } from "../../infrastructure/model-credential-vault";
import { createBoundedFetch } from "../../infrastructure/connected-network";
import { captureConnectionAuthority } from "../../observability/connection-telemetry";
import { defaultModelSetupPolicy, modelSetupPolicySchema, type ModelSetupPolicy } from "./setup-policy";

const createInput = z.strictObject({ providerId: z.string().min(1).max(64), name: z.string().trim().min(1).max(120),
  apiKey: modelApiKeySchema, endpoint: modelEndpointSchema.optional() });
const updateInput = z.strictObject({ expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(120).optional(),
  apiKey: modelApiKeySchema.optional(), endpoint: modelEndpointSchema.optional() });
const changed = () => new PlatformError("MODEL_CONNECTION_CHANGED", 409, "Model provider changed; refresh and try again");
const missing = () => new PlatformError("MODEL_CONNECTION_NOT_FOUND", 404, "Model provider not found");
type ConnectionRow = { id: string; organization_id: string; created_by: string; provider_id: string; name: string; endpoint: string;
  protocol: ProviderConnection["protocol"]; definition: ProviderDefinition; revision: number; credential_revision: number;
  custody: ProviderConnection["custody"]; state: ProviderConnection["state"]; verification: ProviderConnection["verification"];
  created_at: Date; updated_at: Date };

async function owner(db: PoolClient, scope: ActionScope): Promise<void> {
  await requireActionMember(db, scope);
  if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE",
    [scope.organizationId, scope.accountId])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "An owner must manage model provider keys");
}
function dto(row: ConnectionRow): ProviderConnection {
  captureConnectionAuthority({ id: row.id, organization_id: row.organization_id,
    generation: row.credential_revision, policy_revision: row.revision });
  return providerConnectionSchema.parse({ id: row.id, organizationId: row.organization_id, createdBy: row.created_by,
    providerId: row.provider_id, name: row.name, endpoint: row.endpoint, protocol: row.protocol, revision: row.revision,
    credentialRevision: row.credential_revision, custody: row.custody, state: row.state, verification: row.verification,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
}

export class ModelProviderStore {
  private readonly setupPolicy: ModelSetupPolicy;
  constructor(readonly pool: Pool, private readonly vault: ModelCredentialVault | undefined,
    readonly registry: readonly ProviderDefinition[] = builtinProviderRegistry,
    private readonly setupOptions: { discoveryFetch?: ModelDiscoveryFetch; policy?: ModelSetupPolicy } = {}) {
    this.setupPolicy = modelSetupPolicySchema.parse(setupOptions.policy ?? defaultModelSetupPolicy);
  }

  private requireVault(): ModelCredentialVault {
    if (!this.vault) throw new PlatformError("MODEL_VAULT_UNAVAILABLE", 503, "Model credential storage is unavailable");
    return this.vault;
  }
  private async row(db: PoolClient, scope: ActionScope, id: string, write = false): Promise<ConnectionRow> {
    z.uuid().parse(id); await requireActionMember(db, scope);
    const row = (await db.query<ConnectionRow>("SELECT * FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND id=$2" +
      (write ? " FOR UPDATE" : " FOR SHARE"), [scope.organizationId, id])).rows[0];
    if (!row || row.state === "removed") throw missing();
    return row;
  }
  async list(scope: ActionScope): Promise<ProviderConnection[]> {
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      return (await db.query<ConnectionRow>("SELECT * FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND state<>'removed' ORDER BY created_at,id",
        [scope.organizationId])).rows.map(dto);
    });
  }
  async get(scope: ActionScope, id: string): Promise<ProviderConnection> {
    return transaction(this.pool, async db => dto(await this.row(db, scope, id)));
  }
  async create(scope: ActionScope, raw: unknown): Promise<ProviderConnection> {
    const input = createInput.parse(raw), definition = getProviderDefinition(input.providerId, this.registry);
    if (!definition) throw new PlatformError("MODEL_PROVIDER_UNSUPPORTED", 400, "Model provider is not supported");
    const vault = this.requireVault();
    return transaction(this.pool, async db => {
      await owner(db, scope);
      const id = randomUUID(), endpoint = input.endpoint ?? definition.baseUrl;
      const context = { organizationId: scope.organizationId, connectionId: id, credentialRevision: 1, endpoint, protocol: definition.protocol };
      const envelope = vault.seal(context, input.apiKey);
      const row = (await db.query<ConnectionRow>(`INSERT INTO agents_platform.model_provider_connections
        (id,organization_id,created_by,provider_id,name,endpoint,protocol,definition) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, scope.organizationId, scope.accountId, definition.id, input.name, endpoint, definition.protocol, definition])).rows[0]!;
      await db.query(`INSERT INTO agents_platform.model_provider_credentials(organization_id,connection_id,revision,endpoint,protocol,envelope,state)
        VALUES($1,$2,1,$3,$4,$5,'active')`, [scope.organizationId, id, endpoint, definition.protocol, envelope]);
      return dto(row);
    });
  }
  async update(scope: ActionScope, id: string, raw: unknown): Promise<ProviderConnection> {
    const input = updateInput.parse(raw);
    return transaction(this.pool, async db => {
      await owner(db, scope); const row = await this.row(db, scope, id, true);
      if (row.revision !== input.expectedRevision || row.state === "revoked" && !input.apiKey) throw changed();
      const endpoint = input.endpoint ?? row.endpoint;
      if (endpoint !== row.endpoint && !input.apiKey) throw new PlatformError("MODEL_KEY_REENTRY_REQUIRED", 400, "Enter a key for the new endpoint");
      let credentialRevision = row.credential_revision;
      if (input.apiKey !== undefined) {
        credentialRevision++;
        const envelope = this.requireVault().seal({ organizationId: scope.organizationId, connectionId: id, credentialRevision, endpoint, protocol: row.protocol }, input.apiKey);
        await db.query("UPDATE agents_platform.model_provider_credentials SET state='revoked',envelope=NULL WHERE organization_id=$1 AND connection_id=$2 AND state='active'", [scope.organizationId, id]);
        await db.query(`INSERT INTO agents_platform.model_provider_credentials(organization_id,connection_id,revision,endpoint,protocol,envelope,state)
          VALUES($1,$2,$3,$4,$5,$6,'active')`, [scope.organizationId, id, credentialRevision, endpoint, row.protocol, envelope]);
      }
      const updated = (await db.query<ConnectionRow>(`UPDATE agents_platform.model_provider_connections SET name=$3,endpoint=$4,credential_revision=$5,state='active',
        revision=revision+1,verification=CASE WHEN credential_revision<>$5 THEN 'saved' ELSE verification END,updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`, [scope.organizationId, id, input.name ?? row.name, endpoint, credentialRevision])).rows[0]!;
      return dto(updated);
    });
  }
  async revoke(scope: ActionScope, id: string, expectedRevision: number, remove = false): Promise<ProviderConnection> {
    return transaction(this.pool, async db => {
      await owner(db, scope); const row = await this.row(db, scope, id, true);
      if (row.revision !== expectedRevision) throw changed();
      await db.query("UPDATE agents_platform.model_provider_credentials SET state='revoked',envelope=NULL WHERE organization_id=$1 AND connection_id=$2", [scope.organizationId, id]);
      await db.query("UPDATE agents_platform.model_provider_use_grants SET state='revoked',revision=revision+1 WHERE organization_id=$1 AND connection_id=$2 AND state='active'", [scope.organizationId, id]);
      return dto((await db.query<ConnectionRow>(`UPDATE agents_platform.model_provider_connections SET state=$3,revision=revision+1,verification='saved',updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`, [scope.organizationId, id, remove ? "removed" : "revoked"])).rows[0]!);
    });
  }
  async grant(scope: ActionScope, raw: unknown): Promise<ProviderUseGrant> {
    const input = providerUseGrantSchema.omit({ id: true, organizationId: true, revision: true, state: true }).parse(raw);
    return transaction(this.pool, async db => {
      await owner(db, scope); const connection = await this.row(db, scope, input.connectionId, true);
      if (connection.state !== "active") throw changed();
      if (input.consumer.kind === "agent" && !(await db.query("SELECT 1 FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [scope.organizationId, input.consumer.agentId])).rowCount) {
        throw new PlatformError("MODEL_CONSUMER_NOT_FOUND", 404, "Agent not found");
      }
      const result = providerUseGrantSchema.parse({ ...input, id: randomUUID(), organizationId: scope.organizationId, revision: 1, state: "active" });
      await db.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
        VALUES($1,$2,$3,$4,$5,$6)`, [result.id, result.organizationId, result.connectionId, result.consumer, JSON.stringify(result.roles), JSON.stringify(result.modelIds)]);
      return result;
    });
  }

  async cachedModels(scope: ActionScope, id: string): Promise<{
    result: ModelDiscoveryResult | null; fetchedAt: string | null; stale: boolean; connectionRevision: number; credentialRevision: number;
  }> {
    return transaction(this.pool, async db => {
      await owner(db, scope); const connection = await this.row(db, scope, id);
      if (connection.state !== "active") throw changed();
      const cache = (await db.query(`SELECT snapshot,snapshot_digest,fetched_at FROM agents_platform.model_provider_catalogues
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4`,
      [scope.organizationId, id, connection.revision, connection.credential_revision])).rows[0];
      if (cache && requestDigest(cache.snapshot) !== cache.snapshot_digest) throw new PlatformError("MODEL_CATALOGUE_INTEGRITY", 409, "Model catalogue has changed");
      return { result: cache?.snapshot ?? null, fetchedAt: cache ? cache.fetched_at.toISOString() : null,
        stale: !cache || Date.now() - cache.fetched_at.getTime() >= this.setupPolicy.catalogueTtlMs,
        connectionRevision: connection.revision, credentialRevision: connection.credential_revision };
    });
  }

  async refreshModels(scope: ActionScope, id: string, expectedRevision: number): Promise<ModelDiscoveryResult> {
    const prepared = await transaction(this.pool, async db => {
      await owner(db, scope); const connection = await this.row(db, scope, id);
      if (connection.revision !== expectedRevision || connection.state !== "active") throw changed();
      const credential = (await db.query(`SELECT envelope FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2
        AND revision=$3 AND endpoint=$4 AND protocol=$5 AND state='active' FOR SHARE`,
      [scope.organizationId, id, connection.credential_revision, connection.endpoint, connection.protocol])).rows[0];
      if (!credential) throw changed();
      const apiKey = this.requireVault().open({ organizationId: scope.organizationId, connectionId: id,
        credentialRevision: connection.credential_revision, endpoint: connection.endpoint, protocol: connection.protocol }, credential.envelope);
      return { connection, apiKey, definition: providerDefinitionSchema.parse(connection.definition) };
    });
    const reauthorize = () => transaction(this.pool, async db => {
      await owner(db, scope); const current = await this.row(db, scope, id);
      if (current.state !== "active" || current.revision !== expectedRevision || current.credential_revision !== prepared.connection.credential_revision) throw changed();
    });
    // Secrets remain in this API process. They are not part of the cached snapshot or a durable step result.
    const network: ModelDiscoveryFetch = this.setupOptions.discoveryFetch ?? (async request => {
      const destination = new URL(request.url);
      const bounded = createBoundedFetch({ authorizeUrl: url => url.href === destination.href,
        headers: { ...request.headers }, maxRequestBytes: 1, maxResponseBytes: request.maxResponseBytes,
        maxRequests: 1, maxAttempts: 1, deadlineAt: Date.now() + this.setupPolicy.discoveryDeadlineMs,
        returnAuthenticationResponses: true, returnProviderErrorResponses: true, beforeAttempt: reauthorize });
      const response = await bounded(request.url, { method: request.method, redirect: "error" });
      return { status: response.status, body: await response.text() };
    });
    await reauthorize();
    let result: ModelDiscoveryResult;
    try {
      result = await discoverProviderModels(prepared.definition, { apiKey: prepared.apiKey, endpoint: prepared.connection.endpoint,
        fetch: network, observedAt: new Date().toISOString(), maxResponseBytes: this.setupPolicy.maxCatalogueBytes, maxModels: this.setupPolicy.maxCatalogueModels });
    } catch (error) {
      if (!(error instanceof ModelDiscoveryError)) throw error;
      throw new PlatformError(`MODEL_DISCOVERY_${error.code.toUpperCase()}`, 502, "Could not refresh provider models");
    }
    await transaction(this.pool, async db => {
      await owner(db, scope); const current = await this.row(db, scope, id, true);
      if (current.state !== "active" || current.revision !== expectedRevision || current.credential_revision !== prepared.connection.credential_revision) throw changed();
      await db.query(`INSERT INTO agents_platform.model_provider_catalogues AS cache(organization_id,connection_id,connection_revision,credential_revision,snapshot,snapshot_digest,fetched_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,connection_id,connection_revision,credential_revision)
        DO UPDATE SET snapshot=excluded.snapshot,snapshot_digest=excluded.snapshot_digest,fetched_at=excluded.fetched_at
        WHERE excluded.fetched_at>=cache.fetched_at`,
      [scope.organizationId, id, current.revision, current.credential_revision, result, requestDigest(result), result.observedAt]);
      if (result.kind === "discovered") await db.query(`UPDATE agents_platform.model_provider_connections SET
        verification=CASE WHEN verification='saved' THEN 'discovered' ELSE verification END WHERE organization_id=$1 AND id=$2`, [scope.organizationId, id]);
    });
    return result;
  }

  // Call only inside the physical dispatch transaction using the admitted consumer identity.
  async resolveCredential(db: PoolClient, raw: ResolvedModelBinding, consumer: ProviderUseGrant["consumer"]): Promise<string> {
    const binding = resolvedModelBindingSchema.parse(raw);
    const connection = (await db.query<ConnectionRow>("SELECT * FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND id=$2 FOR SHARE",
      [binding.organizationId, binding.connectionId])).rows[0];
    if (!connection || connection.state !== "active" || connection.revision !== binding.connectionRevision ||
      connection.credential_revision !== binding.credentialRevision || connection.endpoint !== binding.endpoint || connection.protocol !== binding.protocol) throw changed();
    const grant = (await db.query("SELECT * FROM agents_platform.model_provider_use_grants WHERE organization_id=$1 AND id=$2 AND connection_id=$3 FOR SHARE",
      [binding.organizationId, binding.useGrantId, binding.connectionId])).rows[0];
    if (!grant || grant.state !== "active" || grant.revision !== binding.useGrantRevision || canonicalJson(grant.consumer) !== canonicalJson(consumer) ||
      !grant.roles.includes(binding.role) || !grant.model_ids.includes(binding.modelId)) {
      throw new PlatformError("MODEL_USE_DENIED", 403, "Model use is not authorized");
    }
    const definition = providerDefinitionSchema.parse(connection.definition);
    if (requestDigest(definition) !== binding.providerDefinitionDigest || definition.id !== binding.providerId ||
      definition.protocol !== binding.protocol || definition.adapter.id !== binding.adapterId || definition.adapter.revision !== binding.adapterRevision) throw changed();
    const credential = (await db.query(`SELECT envelope FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2
      AND revision=$3 AND endpoint=$4 AND protocol=$5 AND state='active' FOR SHARE`,
    [binding.organizationId, binding.connectionId, binding.credentialRevision, binding.endpoint, binding.protocol])).rows[0];
    if (!credential) throw changed();
    return this.requireVault().open({ organizationId: binding.organizationId, connectionId: binding.connectionId,
      credentialRevision: binding.credentialRevision, endpoint: binding.endpoint, protocol: binding.protocol }, credential.envelope);
  }
}
