import { modelToolSupport, type ModelToolSupport } from "../../adapters/models/model-capabilities";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { builtinProviderRegistry, getProviderDefinition } from "../../adapters/models/registry";
import { ModelDiscoveryError, type ModelDiscoveryFetch, type ModelDiscoveryResult } from "../../adapters/models/discovery";
import { modelProviderAdapter } from "../../adapters/models/model-adapter";
import { enrichProviderModels } from "../../adapters/models/model-metadata";
import type { ActionScope } from "../../contracts/connections";
import { canonicalJson, PlatformError, requestDigest } from "../../contracts/contracts";
import { modelEndpointSchema, providerConnectionSchema, providerDefinitionSchema, providerUseGrantSchema,
  resolvedModelBindingSchema, managedModelIds, type ProviderConnection, type ProviderDefinition, type ProviderUseGrant, type ResolvedModelBinding } from "../../contracts/model-providers";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ModelCredentialVault, modelApiKeySchema } from "../../infrastructure/model-credential-vault";
import { createBoundedFetch } from "../../infrastructure/connected-network";
import { captureConnectionAuthority } from "../../observability/connection-telemetry";
import { defaultModelSetupPolicy, modelSetupPolicySchema, type ModelSetupPolicy } from "./setup-policy";
import { probeProviderModel, type ModelProviderProbeRequest, type ModelProviderProbeResult } from "./probe";
import { modelDescriptorSchema, modelIdSchema } from "../../contracts/model-providers";
import { manualModelInput, manualModelDescriptor, overlayManualModel } from "./manual-model";
import { ProviderTransportError } from "../../adapters/models/pi-transport";
import { assertAgentsPaidPlan } from "../billing/billing";

const createInput = z.strictObject({ providerId: z.string().min(1).max(64), name: z.string().trim().min(1).max(120),
  apiKey: modelApiKeySchema, endpoint: modelEndpointSchema.optional() });
const updateInput = z.strictObject({ expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(120).optional(),
  apiKey: modelApiKeySchema.optional(), endpoint: modelEndpointSchema.optional() });
const changed = () => new PlatformError("MODEL_CONNECTION_CHANGED", 409, "Model provider changed; refresh and try again");
const managedReadOnly = () => new PlatformError("MODEL_MANAGED_READ_ONLY", 403, "Add your own provider to change the managed model or key");
const missing = () => new PlatformError("MODEL_CONNECTION_NOT_FOUND", 404, "Model provider not found");
type ConnectionRow = { id: string; organization_id: string; created_by: string; provider_id: string; name: string; endpoint: string;
  protocol: ProviderConnection["protocol"]; definition: ProviderDefinition; revision: number; credential_revision: number;
  managed_model_id?: string | null; managed_model_ids?: string[] | null; custody: ProviderConnection["custody"]; state: ProviderConnection["state"]; verification: ProviderConnection["verification"];
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
    private readonly setupOptions: { discoveryFetch?: ModelDiscoveryFetch; policy?: ModelSetupPolicy;
      probe?: (input: ModelProviderProbeRequest) => Promise<ModelProviderProbeResult> } = {}) {
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
    await assertAgentsPaidPlan(this.pool, scope.organizationId);
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
      if (row.managed_model_id) throw managedReadOnly();
      if (row.revision !== input.expectedRevision || row.state === "revoked" && !input.apiKey) throw changed();
      const endpoint = input.endpoint ?? row.endpoint;
      const definition = getProviderDefinition(row.provider_id, this.registry);
      if (!definition) throw new PlatformError("MODEL_PROVIDER_UNSUPPORTED", 409, "Model provider is unavailable");
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
        revision=revision+1,verification=CASE WHEN credential_revision<>$5 OR definition<>$6::jsonb THEN 'saved' ELSE verification END,
        definition=$6,updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`, [scope.organizationId, id, input.name ?? row.name, endpoint, credentialRevision, definition])).rows[0]!;
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
      if (connection.managed_model_id && input.modelIds.some(id => !managedModelIds(connection)!.includes(id))) throw managedReadOnly();
      if (input.consumer.kind === "agent" && !(await db.query("SELECT 1 FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [scope.organizationId, input.consumer.agentId])).rowCount) {
        throw new PlatformError("MODEL_CONSUMER_NOT_FOUND", 404, "Agent not found");
      }
      const result = providerUseGrantSchema.parse({ ...input, id: randomUUID(), organizationId: scope.organizationId, revision: 1, state: "active" });
      await db.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
        VALUES($1,$2,$3,$4,$5,$6)`, [result.id, result.organizationId, result.connectionId, result.consumer, JSON.stringify(result.roles), JSON.stringify(result.modelIds)]);
      return result;
    });
  }

  async getDefault(scope: ActionScope): Promise<{ selection: { kind: "connection"; connectionId: string; modelId: string } | null; revision: number }> {
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      const row = (await db.query("SELECT connection_id,model_id,revision FROM agents_platform.model_provider_defaults WHERE organization_id=$1",
        [scope.organizationId])).rows[0];
      return { selection: row ? { kind: "connection", connectionId: row.connection_id, modelId: row.model_id } : null, revision: row?.revision ?? 0 };
    });
  }

  async setDefault(scope: ActionScope, raw: unknown): Promise<Awaited<ReturnType<ModelProviderStore["getDefault"]>>> {
    const input = z.strictObject({ connectionId: z.uuid(), modelId: modelIdSchema,
      expectedRevision: z.number().int().nonnegative().nullable() }).parse(raw);
    return transaction(this.pool, async db => {
      await owner(db, scope);
      // The organization lock also orders default changes against new admissions.
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      const prior = (await db.query("SELECT revision FROM agents_platform.model_provider_defaults WHERE organization_id=$1 FOR UPDATE", [scope.organizationId])).rows[0];
      if ((prior?.revision ?? 0) !== (input.expectedRevision ?? 0)) throw new PlatformError("MODEL_DEFAULT_CHANGED", 409, "Default model changed; refresh and try again");
      const connection = await this.row(db, scope, input.connectionId);
      if (connection.state !== "active") throw changed();
      if (connection.managed_model_id && !managedModelIds(connection)!.includes(input.modelId)) throw managedReadOnly();
      const grantId = randomUUID(), revision = (prior?.revision ?? 0) + 1;
      await db.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
        VALUES($1,$2,$3,$4,$5,$6)`, [grantId, scope.organizationId, connection.id,
        { kind: "service", serviceId: "organization-default", product: "agents" },
        JSON.stringify(["primary", "compaction", "delegated"]), JSON.stringify([input.modelId])]);
      await db.query(`INSERT INTO agents_platform.model_provider_defaults(organization_id,connection_id,model_id,use_grant_id,revision,updated_by)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(organization_id) DO UPDATE SET connection_id=excluded.connection_id,
        model_id=excluded.model_id,use_grant_id=excluded.use_grant_id,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=now()`,
      [scope.organizationId, connection.id, input.modelId, grantId, revision, scope.accountId]);
      // A new default affects new admissions. Previously admitted work retains its original grant until explicitly revoked.
      return { selection: { kind: "connection" as const, connectionId: connection.id, modelId: input.modelId }, revision };
    });
  }

  async cachedModels(scope: ActionScope, id: string, agentId?: string, allowPaidModels = true): Promise<{
    result: ModelDiscoveryResult | null; fetchedAt: string | null; stale: boolean; connectionRevision: number; credentialRevision: number;
    status: "fresh" | "stale" | "refreshing" | "backoff" | "unavailable" | "empty"; retryAt: string | null; errorCode: string | null;
    modelVerifications: Record<string, "inference_verified" | "tools_verified">;
    toolSupport: Record<string, ModelToolSupport>;
  }> {
    return transaction(this.pool, async db => {
      if (agentId) {
        z.uuid().parse(agentId); await requireActionMember(db, scope);
        if (!(await db.query("SELECT 1 FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [scope.organizationId, agentId])).rowCount) {
          throw new PlatformError("AGENT_NOT_FOUND", 404, "Agent not found");
        }
      } else await requireActionMember(db, scope);
      const connection = await this.row(db, scope, id);
      if (connection.state !== "active") throw changed();
      const cache = (await db.query(`SELECT snapshot,snapshot_digest,fetched_at FROM agents_platform.model_provider_catalogues
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4`,
      [scope.organizationId, id, connection.revision, connection.credential_revision])).rows[0];
      if (cache && requestDigest(cache.snapshot) !== cache.snapshot_digest) throw new PlatformError("MODEL_CATALOGUE_INTEGRITY", 409, "Model catalogue has changed");
      let result: ModelDiscoveryResult | null = cache?.snapshot ?? null;
      if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL",
        [scope.organizationId, scope.accountId])).rowCount && result) {
        const grants = (await db.query(`SELECT model_ids FROM agents_platform.model_provider_use_grants
          WHERE organization_id=$1 AND connection_id=$2 AND state='active' AND roles ?& ARRAY['primary','compaction','delegated']
          AND (consumer=$3::jsonb OR id IN (SELECT use_grant_id FROM agents_platform.model_provider_defaults WHERE organization_id=$1))`,
        [scope.organizationId, id, JSON.stringify(agentId ? { kind: "agent", agentId } : null)])).rows;
        const allowed = new Set(grants.flatMap(row => row.model_ids as string[]));
        result = { ...result, models: result.models.filter(model => allowed.has(model.id)) };
        if (result.kind === "discovered") result.unavailableModelIds = result.unavailableModelIds?.filter(id => allowed.has(id));
      }
      // Free plans keep the free managed models; paid plans receive the full allowlisted catalogue.
      if (!allowPaidModels && connection.custody === "platform_managed" && result) {
        result = { ...result, models: result.models.filter(model =>
          (model.pricing?.inputMicrosPerMillionTokens ?? 0) === 0 && (model.pricing?.outputMicrosPerMillionTokens ?? 0) === 0) };
      }
      const control = (await db.query(`SELECT lease_until,retry_at,error_code FROM agents_platform.model_provider_catalogue_controls
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4`,
      [scope.organizationId, id, connection.revision, connection.credential_revision])).rows[0];
      const receipts = (await db.query(`SELECT model_id,model_revision,verification FROM agents_platform.model_provider_verifications
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4
          AND endpoint=$5 AND protocol=$6 AND (model_id,model_revision) IN
            (SELECT id,revision FROM jsonb_to_recordset($7::jsonb) AS current_models(id text,revision text))`,
      [scope.organizationId, id, connection.revision, connection.credential_revision, connection.endpoint, connection.protocol,
        JSON.stringify((result?.models ?? []).map(model => ({ id: model.id, revision: model.revision })))])).rows;
      const verified = new Map<string, "inference_verified" | "tools_verified">(receipts.map(receipt => [receipt.model_id, receipt.verification]));
      const modelVerifications: Record<string, "inference_verified" | "tools_verified"> = Object.create(null);
      const toolSupport: Record<string, ModelToolSupport> = Object.create(null);
      for (const model of result?.models ?? []) {
        const receipt = verified.get(model.id);
        if (receipt) modelVerifications[model.id] = receipt;
        toolSupport[model.id] = modelToolSupport(model, modelVerifications[model.id]);
      }
      const now = Date.now(), stale = !cache || now - cache.fetched_at.getTime() >= this.setupPolicy.catalogueTtlMs;
      const status = control?.lease_until?.getTime() > now ? "refreshing" : control?.error_code
        ? (control.retry_at?.getTime() > now ? "backoff" : cache ? "stale" : "unavailable") : !cache ? "empty" : stale ? "stale" : "fresh";
      return { status, modelVerifications, toolSupport, retryAt: control?.retry_at?.toISOString() ?? null, errorCode: control?.error_code ?? null,
        result, fetchedAt: cache ? cache.fetched_at.toISOString() : null,
        stale: !cache || Date.now() - cache.fetched_at.getTime() >= this.setupPolicy.catalogueTtlMs,
        connectionRevision: connection.revision, credentialRevision: connection.credential_revision };
    });
  }

  async addManualModel(scope: ActionScope, id: string, raw: unknown): Promise<{ model: import("../../contracts/model-providers").ModelDescriptor }> {
    const input = manualModelInput.parse(raw);
    const definition = await transaction(this.pool, async db => {
      await owner(db, scope); const connection = await this.row(db, scope, id);
      if (managedModelIds(connection)) throw managedReadOnly();
      if (connection.state !== "active" || connection.revision !== input.expectedRevision) throw changed();
      return providerDefinitionSchema.parse(connection.definition);
    });
    const observedAt = new Date().toISOString();
    let model = await manualModelDescriptor(definition, scope.accountId, input, observedAt);
    await transaction(this.pool, async db => {
      await owner(db, scope); const connection = await this.row(db, scope, id, true);
      if (connection.state !== "active" || connection.revision !== input.expectedRevision) throw changed();
      const key = [scope.organizationId, id, connection.revision, connection.credential_revision];
      const cache = (await db.query(`SELECT snapshot,snapshot_digest,fetched_at FROM agents_platform.model_provider_catalogues
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4 FOR UPDATE`, key)).rows[0];
      if (cache && requestDigest(cache.snapshot) !== cache.snapshot_digest) throw new PlatformError("MODEL_CATALOGUE_INTEGRITY", 409, "Model catalogue has changed");
      const prior: ModelDiscoveryResult = cache?.snapshot ?? { kind: "manual_required", models: [], observedAt };
      model = overlayManualModel(prior.models.find(item => item.id === model.id), model);
      await db.query(`INSERT INTO agents_platform.model_provider_manual_models
        (organization_id,connection_id,connection_revision,credential_revision,model_id,descriptor,descriptor_digest,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,connection_id,connection_revision,credential_revision,model_id)
        DO UPDATE SET descriptor=excluded.descriptor,descriptor_digest=excluded.descriptor_digest,created_by=excluded.created_by,updated_at=now()`,
      [...key, model.id, model, requestDigest(model), scope.accountId]);
      const result: ModelDiscoveryResult = { ...prior, models: [...prior.models.filter(item => item.id !== model.id), model] };
      if (result.kind === "discovered") result.unavailableModelIds = result.unavailableModelIds?.filter(value => value !== model.id);
      if (result.models.length > this.setupPolicy.maxCatalogueModels) throw new PlatformError("MODEL_CATALOGUE_LIMIT", 409, "Model catalogue is full");
      await db.query(`INSERT INTO agents_platform.model_provider_catalogues AS cache
        (organization_id,connection_id,connection_revision,credential_revision,snapshot,snapshot_digest,fetched_at)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(organization_id,connection_id,connection_revision,credential_revision)
        DO UPDATE SET snapshot=excluded.snapshot,snapshot_digest=excluded.snapshot_digest`, [...key, result, requestDigest(result), cache?.fetched_at ?? observedAt]);
    });
    return { model };
  }

  async probe(scope: ActionScope, id: string, raw: unknown): Promise<ModelProviderProbeResult> {
    const input = z.strictObject({ expectedRevision: z.number().int().positive(), modelId: modelIdSchema,
      allowBillableRequest: z.literal(true), verifyTools: z.boolean() }).parse(raw);
    const prepared = await transaction(this.pool, async db => {
      await owner(db, scope); const connection = await this.row(db, scope, id);
      if (connection.revision !== input.expectedRevision || connection.state !== "active") throw changed();
      if (connection.managed_model_id && !managedModelIds(connection)!.includes(input.modelId)) throw managedReadOnly();
      const cache = (await db.query(`SELECT snapshot,snapshot_digest FROM agents_platform.model_provider_catalogues
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4`,
      [scope.organizationId, id, connection.revision, connection.credential_revision])).rows[0];
      if (!cache || requestDigest(cache.snapshot) !== cache.snapshot_digest) {
        throw new PlatformError("MODEL_METADATA_REQUIRED", 409, "Refresh models before testing");
      }
      const found = cache.snapshot.models?.find((model: { id: string }) => model.id === input.modelId);
      if (!found) throw new PlatformError("MODEL_METADATA_REQUIRED", 409, "Known model metadata is required before testing");
      const model = modelDescriptorSchema.parse(found);
      const credential = (await db.query(`SELECT envelope FROM agents_platform.model_provider_credentials
        WHERE organization_id=$1 AND connection_id=$2 AND revision=$3 AND state='active'`,
      [scope.organizationId, id, connection.credential_revision])).rows[0];
      if (!credential) throw changed();
      const apiKey = this.requireVault().open({ organizationId: scope.organizationId, connectionId: id,
        credentialRevision: connection.credential_revision, endpoint: connection.endpoint, protocol: connection.protocol }, credential.envelope);
      return { connection, model, apiKey, definition: providerDefinitionSchema.parse(connection.definition) };
    });
    const reauthorize = () => transaction(this.pool, async db => {
      await owner(db, scope); const current = await this.row(db, scope, id);
      if (current.state !== "active" || current.revision !== input.expectedRevision || current.credential_revision !== prepared.connection.credential_revision) throw changed();
    });
    await reauthorize();
    let result: ModelProviderProbeResult;
    try {
      result = await (this.setupOptions.probe ?? probeProviderModel)({ provider: prepared.definition,
        endpoint: prepared.connection.endpoint, apiKey: prepared.apiKey, model: prepared.model, verifyTools: input.verifyTools,
        policy: this.setupPolicy, reauthorize });
    } catch (error) {
      if (!(error instanceof ProviderTransportError)) throw error;
      throw new PlatformError(error.code, error.status, error.outcome === "uncertain"
        ? "The model test outcome is uncertain; check provider usage before retrying" : "The provider could not complete the model test");
    }
    if (result.modelId !== input.modelId || result.verification !== (input.verifyTools ? "tools_verified" : "inference_verified")) {
      throw new PlatformError("MODEL_PROBE_INVALID", 502, "The model test could not be verified");
    }
    await transaction(this.pool, async db => {
      await owner(db, scope); const current = await this.row(db, scope, id, true);
      if (current.state !== "active" || current.revision !== input.expectedRevision || current.credential_revision !== prepared.connection.credential_revision) throw changed();
      await db.query(`INSERT INTO agents_platform.model_provider_verifications AS receipt
        (organization_id,connection_id,connection_revision,credential_revision,endpoint,protocol,model_id,model_revision,verification)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(organization_id,connection_id,connection_revision,credential_revision,model_id) DO UPDATE SET
        model_revision=excluded.model_revision,verification=CASE WHEN receipt.model_revision=excluded.model_revision AND receipt.verification='tools_verified'
        THEN receipt.verification ELSE excluded.verification END,observed_at=now()`,
      [scope.organizationId, id, current.revision, current.credential_revision, current.endpoint, current.protocol,
        input.modelId, prepared.model.revision, result.verification]);
      await db.query(`UPDATE agents_platform.model_provider_connections SET verification=CASE
        WHEN verification='tools_verified' THEN verification ELSE $3 END WHERE organization_id=$1 AND id=$2`,
      [scope.organizationId, id, result.verification]);
    });
    // The public result deliberately excludes native continuation and request/response bodies.
    return { verification: result.verification, modelId: result.modelId, usage: result.usage };
  }

  async refreshModels(scope: ActionScope, id: string, expectedRevision: number): Promise<ModelDiscoveryResult> {
    const leaseId = randomUUID();
    const prepared = await transaction(this.pool, async db => {
      await owner(db, scope); const connection = await this.row(db, scope, id);
      if (connection.revision !== expectedRevision || connection.state !== "active") throw changed();
      const credential = (await db.query(`SELECT envelope FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2
        AND revision=$3 AND endpoint=$4 AND protocol=$5 AND state='active' FOR SHARE`,
      [scope.organizationId, id, connection.credential_revision, connection.endpoint, connection.protocol])).rows[0];
      if (!credential) throw changed();
      const apiKey = this.requireVault().open({ organizationId: scope.organizationId, connectionId: id,
        credentialRevision: connection.credential_revision, endpoint: connection.endpoint, protocol: connection.protocol }, credential.envelope);
      const key = [scope.organizationId, id, connection.revision, connection.credential_revision];
      await db.query(`INSERT INTO agents_platform.model_provider_catalogue_controls
        (organization_id,connection_id,connection_revision,credential_revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, key);
      const claim = await db.query(`UPDATE agents_platform.model_provider_catalogue_controls SET lease_id=$5,
        lease_until=now()+($6::text||' milliseconds')::interval WHERE organization_id=$1 AND connection_id=$2
        AND connection_revision=$3 AND credential_revision=$4 AND (lease_until IS NULL OR lease_until<=now())
        AND (retry_at IS NULL OR retry_at<=now()) RETURNING failure_count`, [...key, leaseId, this.setupPolicy.discoveryDeadlineMs + 5000]);
      if (!claim.rowCount) throw new PlatformError("MODEL_DISCOVERY_BACKOFF", 429, "Model refresh is already running or temporarily limited; use the cached models");
      return { connection, apiKey, definition: providerDefinitionSchema.parse(connection.definition), failures: claim.rows[0].failure_count };
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
      result = await modelProviderAdapter.discover(prepared.definition, { apiKey: prepared.apiKey, endpoint: prepared.connection.endpoint,
        fetch: network, observedAt: new Date().toISOString(), maxResponseBytes: this.setupPolicy.maxCatalogueBytes, maxModels: this.setupPolicy.maxCatalogueModels });
      if (result.kind === "discovered") result.models = await enrichProviderModels(prepared.definition.id, result.models, result.observedAt);
    } catch (error) {
      const code = error instanceof ModelDiscoveryError ? `MODEL_DISCOVERY_${error.code.toUpperCase()}` : "MODEL_DISCOVERY_UNAVAILABLE";
      const backoff = Math.min(this.setupPolicy.refreshMaxBackoffMs,
        this.setupPolicy.refreshMinIntervalMs * 2 ** Math.min(prepared.failures, 20));
      await this.pool.query(`UPDATE agents_platform.model_provider_catalogue_controls SET lease_id=NULL,lease_until=NULL,
        failure_count=least(failure_count+1,100),error_code=$6,retry_at=now()+($7::text||' milliseconds')::interval
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4 AND lease_id=$5`,
      [scope.organizationId, id, expectedRevision, prepared.connection.credential_revision, leaseId, code, backoff]);
      throw new PlatformError(code, 502, "Could not refresh provider models; cached selections are preserved");
    }
    await transaction(this.pool, async db => {
      await owner(db, scope); const current = await this.row(db, scope, id, true);
      if (current.state !== "active" || current.revision !== expectedRevision || current.credential_revision !== prepared.connection.credential_revision) throw changed();
      const key = [scope.organizationId, id, current.revision, current.credential_revision];
      const controls = await db.query(`SELECT 1 FROM agents_platform.model_provider_catalogue_controls
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4 AND lease_id=$5 FOR UPDATE`, [...key, leaseId]);
      if (!controls.rowCount) throw changed();
      const previous = (await db.query(`SELECT snapshot,snapshot_digest FROM agents_platform.model_provider_catalogues
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4 FOR UPDATE`, key)).rows[0];
      if (previous && requestDigest(previous.snapshot) !== previous.snapshot_digest) throw new PlatformError("MODEL_CATALOGUE_INTEGRITY", 409, "Model catalogue has changed");
      if (result.kind === "discovered") {
        const managed = managedModelIds(current);
        if (managed) result.models = result.models.filter(model => managed.includes(model.id));
        const discoveredIds = new Set(result.models.map(model => model.id));
        const priorModels = (previous?.snapshot.models ?? []) as import("../../contracts/model-providers").ModelDescriptor[];
        const absent = priorModels.filter(model => !discoveredIds.has(model.id));
        result.models.push(...absent);
        result.unavailableModelIds = result.complete || current.managed_model_id ? absent.map(model => model.id) : (previous?.snapshot.unavailableModelIds ?? []).filter((id: string) => !discoveredIds.has(id));
      }
      const manual = current.managed_model_id ? [] : (await db.query(`SELECT descriptor,descriptor_digest FROM agents_platform.model_provider_manual_models
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4`, key)).rows;
      for (const item of manual) {
        if (requestDigest(item.descriptor) !== item.descriptor_digest) throw new PlatformError("MODEL_CATALOGUE_INTEGRITY", 409, "Manual model metadata has changed");
        const manualDescriptor = modelDescriptorSchema.parse(item.descriptor);
        const descriptor = overlayManualModel(result.models.find(model => model.id === manualDescriptor.id), manualDescriptor);
        result.models = [...result.models.filter(model => model.id !== descriptor.id), descriptor];
        if (result.kind === "discovered") result.unavailableModelIds = result.unavailableModelIds?.filter(id => id !== descriptor.id);
      }
      await db.query(`UPDATE agents_platform.model_provider_catalogue_controls SET lease_id=NULL,lease_until=NULL,
        failure_count=0,error_code=NULL,retry_at=now()+($6::text||' milliseconds')::interval
        WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4 AND lease_id=$5`,
      [...key, leaseId, this.setupPolicy.refreshMinIntervalMs]);
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
    const enabled = getProviderDefinition(binding.providerId, this.registry);
    if (!enabled || enabled.adapter.readiness !== "installed") {
      throw new PlatformError("MODEL_ADAPTER_NOT_INSTALLED", 503, "The selected model adapter is unavailable");
    }
    const connection = (await db.query<ConnectionRow>("SELECT * FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND id=$2 FOR SHARE",
      [binding.organizationId, binding.connectionId])).rows[0];
    if (!connection || connection.state !== "active" || connection.revision !== binding.connectionRevision ||
      connection.credential_revision !== binding.credentialRevision || connection.endpoint !== binding.endpoint || connection.protocol !== binding.protocol) throw changed();
    if (connection.managed_model_id && !managedModelIds(connection)!.includes(binding.modelId)) throw managedReadOnly();
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
