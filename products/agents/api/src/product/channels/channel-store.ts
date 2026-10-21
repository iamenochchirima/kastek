import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { builtinChannelCatalogue, getChannelDefinition, type ChannelDefinition } from "../../adapters/channels/catalogue";
import { channelKindSchema, type ChannelKind } from "../../contracts/channel-adapters";
import { channelConnectionSchema, channelDeploymentSchema, channelAssetSchema, channelModeSchema,
  type ChannelConnection, type ChannelDeployment, type ChannelAsset } from "../../contracts/channel-connections";
import type { ActionScope } from "../../contracts/connections";
import { DeploymentStore } from "../deployments/deployment-store";
import type { VersionRecord } from "../../contracts/records";
import { canonicalJson, PlatformError } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault, type SecretEnvelope } from "../../infrastructure/vault";

const externalId = z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const revision = z.number().int().positive();
const credentials = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.string().min(1).max(16384))
  .refine(value => Object.keys(value).length > 0 && Buffer.byteLength(canonicalJson(value)) <= 60000, "Invalid credentials");
const metadata = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  if (Buffer.byteLength(canonicalJson(value)) > 16384) context.addIssue({ code: "custom", message: "Metadata is too large" });
  function visit(item: unknown, depth: number): void {
    if (depth > 8) { context.addIssue({ code: "custom", message: "Metadata is too deeply nested" }); return; }
    if (Array.isArray(item)) { for (const entry of item) visit(entry, depth + 1); return; }
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      if (/(?:token|secret|password|authorization|credential|envelope)/i.test(key)) context.addIssue({ code: "custom", message: "Secrets belong in credential storage" });
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
});
const createInput = z.strictObject({ kind: channelKindSchema, name: z.string().trim().min(1).max(120), mode: channelModeSchema,
  assetId: externalId.optional(), credentials: credentials.optional(), metadata: metadata.default({}), state: z.enum(["pending", "active"]).default("pending") });
const updateInput = z.strictObject({ expectedRevision: revision, name: z.string().trim().min(1).max(120).optional(),
  assetId: externalId.optional(), credentials: credentials.optional(), metadata: metadata.optional(),
  state: z.enum(["pending", "active", "needs_attention"]).optional() });
const assetInput = z.strictObject({ providerAssetId: externalId, name: z.string().trim().min(1).max(256),
  eligible: z.boolean(), reasonCode: z.string().max(128).nullable().default(null), metadata: metadata.default({}) });
const changed = () => new PlatformError("CHANNEL_CONNECTION_CHANGED", 409, "Channel connection changed; refresh and try again");
const missing = () => new PlatformError("CHANNEL_CONNECTION_NOT_FOUND", 404, "Channel connection not found");
type Row = Record<string, any>;
function connectionDto(row: Row): ChannelConnection {
  return channelConnectionSchema.parse({ id: row.id, organizationId: row.organization_id, createdBy: row.created_by,
    kind: row.kind, name: row.name, assetId: row.asset_id, mode: row.mode, state: row.state, revision: row.revision,
    credentialRevision: row.credential_revision, metadata: row.metadata, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
}
function deploymentDto(row: Row): ChannelDeployment {
  return channelDeploymentSchema.parse({ id: row.id, organizationId: row.organization_id, connectionId: row.connection_id,
    agentId: row.agent_id, versionId: row.version_id, state: row.state, revision: row.revision, createdBy: row.created_by,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
}
function assetDto(row: Row): ChannelAsset {
  return channelAssetSchema.parse({ id: row.id, organizationId: row.organization_id, connectionId: row.connection_id,
    providerAssetId: row.provider_asset_id, name: row.name, eligible: row.eligible, reasonCode: row.reason_code,
    metadata: row.metadata, observedAt: row.observed_at.toISOString() });
}
async function owner(db: PoolClient, scope: ActionScope): Promise<void> {
  await requireActionMember(db, scope);
  if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE",
    [scope.organizationId, scope.accountId])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "An owner must manage channel connections");
}
function assetConflict(error: unknown): never {
  const failure = error as { code?: string; constraint?: string };
  if (failure.code === "23505" && failure.constraint === "channel_connection_asset_owner") throw new PlatformError("CHANNEL_ASSET_CONFLICT", 409, "This channel asset is already connected");
  throw error;
}
export type ResolvedChannelDeployment = { deployment: ChannelDeployment; connection: ChannelConnection };
export class ChannelStore {
  constructor(readonly pool: Pool, private readonly vault?: ConnectionVault,
    readonly catalogue: readonly ChannelDefinition[] = builtinChannelCatalogue) {}
  private definition(kind: string, mode: string): ChannelDefinition {
    const definition = getChannelDefinition(kind, this.catalogue);
    if (!definition || !definition.modes.includes(mode as any)) throw new PlatformError("CHANNEL_UNSUPPORTED", 400, "Channel connection mode is unavailable");
    return definition;
  }
  private async row(db: PoolClient, scope: ActionScope, id: string, write = false): Promise<Row> {
    z.uuid().parse(id); await requireActionMember(db, scope);
    const row = (await db.query("SELECT * FROM agents_platform.channel_connections WHERE organization_id=$1 AND id=$2" + (write ? " FOR UPDATE" : " FOR SHARE"), [scope.organizationId, id])).rows[0];
    if (!row || row.state === "removed") throw missing(); return row;
  }
  private credentialReference(row: Row): string {
    return canonicalJson({ domain: "channel-credential-v1", connectionId: row.id, kind: row.kind, mode: row.mode, assetId: row.asset_id });
  }
  private seal(row: Row, secret: Record<string, string>, credentialRevision: number): SecretEnvelope {
    if (!this.vault) throw new PlatformError("CHANNEL_VAULT_UNAVAILABLE", 503, "Channel credential storage is unavailable");
    return this.vault.seal(row.organization_id, this.credentialReference(row), credentialRevision,
      canonicalJson({ domain: "channel-credential-v1", credentials: secret }), 65536);
  }
  async list(scope: ActionScope): Promise<ChannelConnection[]> {
    return transaction(this.pool, async db => { await requireActionMember(db, scope);
      return (await db.query("SELECT * FROM agents_platform.channel_connections WHERE organization_id=$1 AND state<>'removed' AND coalesce(metadata->>'evaluationFixture','false')<>'true' ORDER BY created_at,id", [scope.organizationId])).rows.map(connectionDto); });
  }
  async get(scope: ActionScope, id: string): Promise<ChannelConnection> {
    return transaction(this.pool, async db => connectionDto(await this.row(db, scope, id)));
  }
  async create(scope: ActionScope, raw: unknown): Promise<ChannelConnection> {
    const input = createInput.parse(raw); this.definition(input.kind, input.mode);
    if (input.state === "active" && (!input.assetId || input.kind !== "website" && !input.credentials)) throw new PlatformError("CHANNEL_SETUP_REQUIRED", 409, "Verify the selected channel asset before activation");
    try { return await transaction(this.pool, async db => { await owner(db, scope);
      const row = (await db.query(`INSERT INTO agents_platform.channel_connections(id,organization_id,created_by,kind,name,asset_id,mode,state,credential_revision,metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [randomUUID(), scope.organizationId, scope.accountId, input.kind, input.name, input.assetId ?? null, input.mode, input.state, input.credentials ? 1 : 0, input.metadata])).rows[0]!;
      if (input.credentials) await db.query(`INSERT INTO agents_platform.channel_credentials(organization_id,connection_id,revision,kind,mode,asset_id,envelope,state)
        VALUES($1,$2,1,$3,$4,$5,$6,'active')`, [scope.organizationId, row.id, row.kind, row.mode, row.asset_id, this.seal(row, input.credentials, 1)]);
      if (input.assetId) await this.recordAsset(db, row, { providerAssetId: input.assetId, name: input.name, eligible: input.state === "active", reasonCode: input.state === "active" ? null : "verification_required", metadata: {} });
      return connectionDto(row);
    }); } catch (error) { return assetConflict(error); }
  }
  async update(scope: ActionScope, id: string, raw: unknown): Promise<ChannelConnection> {
    const input = updateInput.parse(raw);
    try { return await transaction(this.pool, async db => { await owner(db, scope); const row = await this.row(db, scope, id, true);
      if (row.revision !== input.expectedRevision) throw changed(); this.definition(row.kind, row.mode);
      const assetId = input.assetId ?? row.asset_id;
      if (assetId !== row.asset_id && row.kind !== "website" && !input.credentials) throw new PlatformError("CHANNEL_KEY_REENTRY_REQUIRED", 400, "Reconnect the selected asset with its credentials");
      const nextState = input.state ?? (row.state === "disconnected" ? "pending" : row.state);
      if (nextState === "active" && (!assetId || row.kind !== "website" && !input.credentials && !row.credential_revision)) throw new PlatformError("CHANNEL_SETUP_REQUIRED", 409, "Verify the selected channel asset before activation");
      if (row.state === "disconnected" && nextState === "active" && row.kind !== "website" && !input.credentials) throw new PlatformError("CHANNEL_KEY_REENTRY_REQUIRED", 400, "Reconnect with current credentials");
      const nextCredentialRevision = row.credential_revision + (input.credentials ? 1 : 0);
      if (input.credentials) {
        await db.query("UPDATE agents_platform.channel_credentials SET state='revoked',envelope=NULL,revoked_at=now() WHERE organization_id=$1 AND connection_id=$2 AND state='active'", [scope.organizationId, id]);
        await db.query(`INSERT INTO agents_platform.channel_credentials(organization_id,connection_id,revision,kind,mode,asset_id,envelope,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,'active')`, [scope.organizationId, id, nextCredentialRevision, row.kind, row.mode, assetId, this.seal({ ...row, asset_id: assetId }, input.credentials, nextCredentialRevision)]);
      }
      if (assetId !== row.asset_id || nextState !== "active") await db.query("UPDATE agents_platform.channel_deployments SET state='paused',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND connection_id=$2 AND state='active'", [scope.organizationId, id]);
      const next = (await db.query(`UPDATE agents_platform.channel_connections SET name=$3,asset_id=$4,state=$5,credential_revision=$6,metadata=$7,revision=revision+1,updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`, [scope.organizationId, id, input.name ?? row.name, assetId, nextState, nextCredentialRevision, input.metadata ?? row.metadata])).rows[0]!;
      if (assetId && (assetId !== row.asset_id || nextState !== row.state)) {
        const existingAsset = await db.query("UPDATE agents_platform.channel_assets SET eligible=$4,reason_code=$5,observed_at=now() WHERE organization_id=$1 AND connection_id=$2 AND provider_asset_id=$3", [scope.organizationId, id, assetId, nextState === "active", nextState === "active" ? null : "verification_required"]);
        if (!existingAsset.rowCount) await this.recordAsset(db, next, { providerAssetId: assetId, name: next.name, eligible: nextState === "active", reasonCode: nextState === "active" ? null : "verification_required", metadata: {} });
      }
      return connectionDto(next);
    }); } catch (error) { return assetConflict(error); }
  }
  async disconnect(scope: ActionScope, id: string, expectedRevision: number, remove = false): Promise<ChannelConnection> {
    revision.parse(expectedRevision);
    return transaction(this.pool, async db => { await owner(db, scope); const row = await this.row(db, scope, id, true);
      if (row.revision !== expectedRevision) throw changed();
      await db.query("UPDATE agents_platform.channel_credentials SET state='revoked',envelope=NULL,revoked_at=now() WHERE organization_id=$1 AND connection_id=$2 AND state='active'", [scope.organizationId, id]);
      await db.query("UPDATE agents_platform.channel_deployments SET state='revoked',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND connection_id=$2 AND state<>'revoked'", [scope.organizationId, id]);
      return connectionDto((await db.query("UPDATE agents_platform.channel_connections SET state=$3,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *", [scope.organizationId, id, remove ? "removed" : "disconnected"])).rows[0]!);
    });
  }
  async remove(scope: ActionScope, id: string, expectedRevision: number) { return this.disconnect(scope, id, expectedRevision, true); }
  private async recordAsset(db: PoolClient, connection: Row, asset: z.infer<typeof assetInput>): Promise<void> {
    await db.query(`INSERT INTO agents_platform.channel_assets(id,organization_id,connection_id,provider_asset_id,name,eligible,reason_code,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(organization_id,connection_id,provider_asset_id)
      DO UPDATE SET name=excluded.name,eligible=excluded.eligible,reason_code=excluded.reason_code,metadata=excluded.metadata,observed_at=now()`,
    [randomUUID(), connection.organization_id, connection.id, asset.providerAssetId, asset.name, asset.eligible, asset.reasonCode, asset.metadata]);
  }
  /** Called by authenticated provider discovery after checking its current connection revision; never accepts a credential field. */
  async recordAssets(scope: ActionScope, id: string, expectedRevision: number, raw: unknown): Promise<void> {
    const assets = z.array(assetInput).max(100).parse(raw); revision.parse(expectedRevision);
    return transaction(this.pool, async db => { await owner(db, scope); const row = await this.row(db, scope, id, true);
      if (row.revision !== expectedRevision || row.state === "disconnected") throw changed();
      for (const asset of assets) await this.recordAsset(db, row, asset);
      if (row.asset_id && assets.some(asset => asset.providerAssetId === row.asset_id && !asset.eligible)) {
        await db.query("UPDATE agents_platform.channel_connections SET state='needs_attention',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2", [scope.organizationId, id]);
        await db.query("UPDATE agents_platform.channel_deployments SET state='paused',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND connection_id=$2 AND state='active'", [scope.organizationId, id]);
      }
    });
  }
  async listAssets(scope: ActionScope, id: string, raw: unknown = {}): Promise<{ assets: ChannelAsset[]; nextCursor: string | null }> {
    const input = z.strictObject({ cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100).default(50) }).parse(raw);
    return transaction(this.pool, async db => { await this.row(db, scope, id);
      const rows = (await db.query("SELECT * FROM agents_platform.channel_assets WHERE organization_id=$1 AND connection_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4", [scope.organizationId, id, input.cursor ?? null, input.limit + 1])).rows;
      return { assets: rows.slice(0, input.limit).map(assetDto), nextCursor: rows.length > input.limit ? rows[input.limit - 1]!.id : null };
    });
  }
  async listDeployments(scope: ActionScope, connectionId?: string): Promise<ChannelDeployment[]> {
    if (connectionId) z.uuid().parse(connectionId);
    return transaction(this.pool, async db => { await requireActionMember(db, scope);
      return (await db.query(`SELECT d.* FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections c ON c.id=d.connection_id
        WHERE d.organization_id=$1 AND ($2::uuid IS NULL OR d.connection_id=$2) AND coalesce(c.metadata->>'evaluationFixture','false')<>'true'
        ORDER BY d.created_at,d.id`, [scope.organizationId, connectionId ?? null])).rows.map(deploymentDto); });
  }
  async bind(scope: ActionScope, id: string, raw: unknown): Promise<ChannelDeployment> {
    const input = z.strictObject({ expectedRevision: revision, agentId: z.uuid(), assetId: externalId.optional(), confirmReassignment: z.boolean().default(false) }).parse(raw);
    return transaction(this.pool, async db => { await owner(db, scope); const connection = await this.row(db, scope, id, true);
      if (connection.revision !== input.expectedRevision) throw changed(); this.definition(connection.kind, connection.mode);
      if (connection.state !== "active" || !connection.asset_id || input.assetId && input.assetId !== connection.asset_id) throw new PlatformError("CHANNEL_ASSET_UNAVAILABLE", 409, "Connect and select an eligible channel asset first");
      const asset = (await db.query("SELECT 1 FROM agents_platform.channel_assets WHERE organization_id=$1 AND connection_id=$2 AND provider_asset_id=$3 AND eligible=true FOR SHARE", [scope.organizationId, id, connection.asset_id])).rowCount;
      if (!asset) throw new PlatformError("CHANNEL_ASSET_UNAVAILABLE", 409, "The selected channel asset is unavailable");
      const version = (await db.query(`SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a ON a.organization_id=v.organization_id AND a.id=v.agent_id
        WHERE v.organization_id=$1 AND v.agent_id=$2 AND a.offering IN ('faq','customer-service') ORDER BY v.number DESC LIMIT 1 FOR SHARE OF v,a`, [scope.organizationId, input.agentId])).rows[0];
      if (!version || version.configuration.executionKind !== "business") throw new PlatformError("CHANNEL_AGENT_UNAVAILABLE", 409, "Select an existing saved customer agent");
      await new DeploymentStore(this.pool).assertWebsiteConfigurationInTransaction(db, { organizationId: scope.organizationId, agentId: input.agentId, version: version as VersionRecord });
      const existing = (await db.query("SELECT * FROM agents_platform.channel_deployments WHERE organization_id=$1 AND connection_id=$2 AND state='active' FOR UPDATE", [scope.organizationId, id])).rows[0];
      if (existing && existing.agent_id !== input.agentId && !input.confirmReassignment) throw new PlatformError("CHANNEL_REASSIGNMENT_REQUIRED", 409, "Confirm changing the agent serving this channel");
      if (existing?.agent_id === input.agentId) return deploymentDto(existing);
      if (existing) await db.query("UPDATE agents_platform.channel_deployments SET state='revoked',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2", [scope.organizationId, existing.id]);
      return deploymentDto((await db.query(`INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), scope.organizationId, id, input.agentId, version.id, scope.accountId])).rows[0]!);
    });
  }
  /** Internal dispatch only. Call after webhook verification or an authenticated current delivery claim. */
  async resolveDeployment(kind: ChannelKind, assetId: string): Promise<ResolvedChannelDeployment | null> {
    channelKindSchema.parse(kind); externalId.parse(assetId);
    return transaction(this.pool, async db => {
      const rows = (await db.query(`SELECT row_to_json(c) AS connection,row_to_json(d) AS deployment FROM agents_platform.channel_connections c
        JOIN agents_platform.channel_deployments d ON d.organization_id=c.organization_id AND d.connection_id=c.id
        WHERE c.kind=$1 AND c.asset_id=$2 AND c.state='active' AND d.state='active' FOR SHARE OF c,d`, [kind, assetId])).rows;
      if (rows.length > 1) throw new PlatformError("CHANNEL_ASSET_CONFLICT", 409, "Channel asset routing is ambiguous");
      if (!rows[0]) return null;
      const c = rows[0].connection, d = rows[0].deployment;
      for (const value of [c, d]) { value.created_at = new Date(value.created_at); value.updated_at = new Date(value.updated_at); }
      this.definition(c.kind, c.mode); return { connection: connectionDto(c), deployment: deploymentDto(d) };
    });
  }
  /** Secrets never leave this server-only method. Every send must request its current authorized revisions. */
  async resolveCredential(input: { organizationId: string; connectionId: string; expectedRevision?: number; credentialRevision?: number }): Promise<Record<string, string>> {
    z.uuid().parse(input.organizationId); z.uuid().parse(input.connectionId);
    return transaction(this.pool, async db => {
      const row = (await db.query("SELECT * FROM agents_platform.channel_connections WHERE organization_id=$1 AND id=$2 FOR SHARE", [input.organizationId, input.connectionId])).rows[0];
      if (!row || row.state !== "active" || input.expectedRevision !== undefined && row.revision !== input.expectedRevision || input.credentialRevision !== undefined && row.credential_revision !== input.credentialRevision) throw new PlatformError("CHANNEL_AUTHORITY_CHANGED", 403, "Channel authority is unavailable");
      this.definition(row.kind, row.mode);
      return this.openCredential(db, row);
    });
  }
  /** Owner-authorized onboarding only; pending credentials cannot authorize customer sends. */
  async resolveSetupCredential(scope: ActionScope, id: string, expectedRevision: number): Promise<Record<string, string>> {
    revision.parse(expectedRevision);
    return transaction(this.pool, async db => { await owner(db, scope); const row = await this.row(db, scope, id);
      if (row.metadata.evaluationFixture || row.revision !== expectedRevision || !["pending", "active", "needs_attention"].includes(row.state)) throw changed();
      this.definition(row.kind, row.mode); return this.openCredential(db, row);
    });
  }
  /** Private webhook verification only; returning a secret does not authorize routing or sending. */
  async telegramWebhookSecret(id: string): Promise<{assetId:string;secret:string}> {
    z.uuid().parse(id);
    return transaction(this.pool,async db=>{
      const row=(await db.query("SELECT * FROM agents_platform.channel_connections WHERE id=$1 AND kind='telegram' AND state IN ('pending','active','needs_attention') FOR SHARE",[id])).rows[0];
      if(!row?.asset_id||row.metadata.evaluationTrialId)throw missing();
      const credentials=await this.openCredential(db,row);
      if(!credentials.webhookSecret)throw new PlatformError("CHANNEL_WEBHOOK_UNAVAILABLE",403,"Channel webhook is unavailable");
      return {assetId:row.asset_id,secret:credentials.webhookSecret};
    });
  }
  private async openCredential(db: PoolClient, row: Row): Promise<Record<string, string>> {
    const secret = (await db.query("SELECT * FROM agents_platform.channel_credentials WHERE organization_id=$1 AND connection_id=$2 AND revision=$3 AND state='active' FOR SHARE", [row.organization_id, row.id, row.credential_revision])).rows[0];
    if (!secret || secret.kind !== row.kind || secret.mode !== row.mode || secret.asset_id !== row.asset_id || !this.vault) throw new PlatformError("CHANNEL_CREDENTIAL_UNAVAILABLE", 503, "Channel credentials are unavailable");
    try { return z.strictObject({ domain: z.literal("channel-credential-v1"), credentials }).parse(JSON.parse(this.vault.open(row.organization_id, this.credentialReference(row), row.credential_revision, secret.envelope))).credentials; }
    catch { throw new PlatformError("CHANNEL_CREDENTIAL_UNAVAILABLE", 503, "Channel credentials are unavailable"); }
  }
}
