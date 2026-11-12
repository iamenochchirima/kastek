import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { PlatformError, agentConfigurationSchema, type AgentConfiguration } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import type { PrivateObjectStore } from "../../infrastructure/object-store";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { publishedToolBindings } from "../../capabilities/tools";

export type AgentTransferScope = { accountId: string; organizationId: string };
export type AgentTransferRecord = {
  id: string;
  agentId: string;
  targetEmail: string;
  state: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  expiresAt: string;
  createdAt: string;
  settledAt: string | null;
  targetOrganizationId: string | null;
  createdAgentId: string | null;
};
export type AgentTransferPreview = {
  agentName: string;
  agentVersion: number;
  organizationName: string;
  organizationId: string;
  email: string;
  state: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  expiresAt: string;
  sources: { title: string; revision: number }[];
  targetOrganizationId: string | null;
  createdAgentId: string | null;
};
export type TransferEmail = { transfer: AgentTransferRecord; token: string; agentName: string; organizationName: string };

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const maskEmail = (value: string) => {
  const [local, domain] = value.split("@");
  return `${local?.slice(0, 1) ?? ""}***@${domain ?? ""}`;
};
const missing = () => new PlatformError("TRANSFER_NOT_FOUND", 404, "Transfer not found");
const denied = () => new PlatformError("ACCESS_DENIED", 403, "Workspace access is unavailable");
const transferRecord = (row: Record<string, any>): AgentTransferRecord => ({
  id: row.id,
  agentId: row.agent_id,
  targetEmail: row.target_email,
  state: row.state,
  expiresAt: iso(row.expires_at),
  createdAt: iso(row.created_at),
  settledAt: row.settled_at ? iso(row.settled_at) : null,
  targetOrganizationId: row.target_organization_id ?? null,
  createdAgentId: row.created_agent_id ?? null,
});

/** Tools that depend on workspace credentials, channels or other agents are removed before the copy. */
const untransferableTools = new Set([
  "agents.delegate", "agents.discover", "agents.start", "agents.status", "agents.result", "agents.wait", "agents.followup", "agents.cancel",
  "work.update", "work.inspect", "channel.request_handoff", "support.request_handoff", "support.request_handoff_v2", "support.get_status", "support.get_status_v2",
]);

function copiedConfiguration(configuration: AgentConfiguration, revisionIds: Map<string, string>): AgentConfiguration {
  const sourceRevisionIds = configuration.sourceRevisionIds.map(id => {
    const copied = revisionIds.get(id);
    if (!copied) throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "Update this agent's knowledge before transferring it");
    return copied;
  });
  return agentConfigurationSchema.parse({
    ...configuration,
    sourceRevisionIds,
    connectedToolBindingIds: [],
    productBindings: [],
    ...(configuration.commissionableProductBindings ? { commissionableProductBindings: [] } : {}),
    skillIds: [],
    procedures: [],
    model: { ...configuration.model, selection: { kind: "organization_default" } },
    tools: configuration.tools.filter(tool => !untransferableTools.has(tool)),
    capabilities: {
      ...configuration.capabilities,
      delegation: { enabled: false },
      businessActions: { enabled: false },
      workflows: { enabled: false },
    },
  });
}

export class AgentTransferStore {
  constructor(readonly pool: Pool, readonly objects: PrivateObjectStore) {}

  private async expireStale(db: Pool | PoolClient, where: string, value: string): Promise<void> {
    await db.query(`UPDATE agents_platform.agent_transfers SET state='expired',settled_at=now(),updated_at=now()
      WHERE ${where}=$1 AND state='pending' AND expires_at<=now()`, [value]);
  }

  async current(scope: AgentTransferScope, agentId: string): Promise<AgentTransferRecord | null> {
    return transaction(this.pool, async db => {
      await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL", [scope.organizationId, scope.accountId]);
      await this.expireStale(db, "agent_id", agentId);
      const row = (await db.query("SELECT * FROM agents_platform.agent_transfers WHERE organization_id=$1 AND agent_id=$2 AND state='pending' ORDER BY created_at DESC LIMIT 1", [scope.organizationId, agentId])).rows[0];
      return row ? transferRecord(row) : null;
    });
  }

  async initiate(scope: AgentTransferScope, agentId: string, email: string): Promise<TransferEmail> {
    const targetEmail = normalizeEmail(email);
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      const member = (await db.query("SELECT role FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [scope.organizationId, scope.accountId])).rows[0];
      if (!member || member.role !== "owner") throw new PlatformError("TRANSFER_OWNER_REQUIRED", 403, "Only a workspace owner can transfer an agent");
      const account = (await db.query("SELECT email FROM agents_platform.accounts WHERE id=$1", [scope.accountId])).rows[0];
      if (!account) throw denied();
      if (normalizeEmail(account.email) === targetEmail) throw new PlatformError("TRANSFER_SELF", 409, "Choose a different recipient");
      await this.expireStale(db, "agent_id", agentId);
      if ((await db.query("SELECT 1 FROM agents_platform.agent_transfers WHERE organization_id=$1 AND agent_id=$2 AND state='pending'", [scope.organizationId, agentId])).rowCount)
        throw new PlatformError("TRANSFER_PENDING", 409, "A transfer is already waiting to be accepted");
      const agent = (await db.query(`SELECT a.*,o.name AS organization_name,v.id AS version_id,v.number AS version_number,v.configuration
        FROM agents_platform.agents a
        JOIN agents_platform.organizations o ON o.id=a.organization_id
        JOIN LATERAL (SELECT id,number,configuration FROM agents_platform.agent_versions WHERE agent_id=a.id ORDER BY number DESC LIMIT 1) v ON true
        WHERE a.organization_id=$1 AND a.id=$2 AND a.deleted_at IS NULL FOR UPDATE OF a`, [scope.organizationId, agentId])).rows[0];
      if (!agent) throw new PlatformError("NOT_FOUND", 404, "Agent not found");
      if ((await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id
        WHERE v.organization_id=$1 AND v.agent_id=$2 AND (t.state NOT IN ('completed','incomplete','refused','failed','cancelled') OR t.disposition<>'settled') LIMIT 1`, [scope.organizationId, agentId])).rowCount)
        throw new PlatformError("AGENT_TASKS_ACTIVE", 409, "Wait for active agent tasks to finish before transferring");
      const configuration = agentConfigurationSchema.parse(agent.configuration);
      const sources = (await db.query(`SELECT vs.source_id,vs.revision_id,s.title,r.revision
        FROM agents_platform.version_sources vs
        JOIN agents_platform.sources s ON s.organization_id=vs.organization_id AND s.id=vs.source_id
        JOIN agents_platform.source_revisions r ON r.organization_id=vs.organization_id AND r.id=vs.revision_id
        JOIN agents_platform.source_revision_policy p ON p.organization_id=vs.organization_id AND p.revision_id=vs.revision_id
        WHERE vs.organization_id=$1 AND vs.version_id=$2 AND vs.revision_id=ANY($3::uuid[]) AND s.state='active' AND p.state='approved'
        ORDER BY s.title,s.id FOR SHARE OF s,r,p`, [scope.organizationId, agent.version_id, configuration.sourceRevisionIds])).rows;
      if (sources.length !== configuration.sourceRevisionIds.length || new Set(sources.map(source => source.source_id)).size !== sources.length)
        throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "Update this agent's knowledge before transferring it");
      const token = randomBytes(32).toString("base64url"), id = randomUUID();
      const transfer = (await db.query(`INSERT INTO agents_platform.agent_transfers(id,organization_id,agent_id,version_id,initiated_by,target_email,token_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '7 days') RETURNING *`, [id, scope.organizationId, agentId, agent.version_id, scope.accountId, targetEmail, digest(token)])).rows[0]!;
      for (const source of sources) await db.query("INSERT INTO agents_platform.agent_transfer_sources(transfer_id,source_id,revision_id,title) VALUES($1,$2,$3,$4)", [id, source.source_id, source.revision_id, source.title]);
      return { transfer: transferRecord(transfer), token, agentName: agent.name, organizationName: agent.organization_name };
    });
  }

  async cancel(scope: AgentTransferScope, agentId: string, transferId: string): Promise<void> {
    await transaction(this.pool, async db => {
      const member = (await db.query("SELECT role FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL", [scope.organizationId, scope.accountId])).rows[0];
      if (!member || member.role !== "owner") throw new PlatformError("TRANSFER_OWNER_REQUIRED", 403, "Only a workspace owner can cancel a transfer");
      const changed = await db.query(`UPDATE agents_platform.agent_transfers SET state='cancelled',settled_at=now(),updated_at=now()
        WHERE organization_id=$1 AND agent_id=$2 AND id=$3 AND state='pending' RETURNING id`, [scope.organizationId, agentId, transferId]);
      if (!changed.rowCount) throw new PlatformError("TRANSFER_NOT_PENDING", 409, "This transfer is no longer waiting");
    });
  }

  /** An email delivery failure must not leave the agent frozen behind an unusable invitation. */
  async cancelInitiation(transferId: string): Promise<void> {
    await this.pool.query("UPDATE agents_platform.agent_transfers SET state='cancelled',settled_at=now(),updated_at=now() WHERE id=$1 AND state='pending'", [transferId]);
  }

  async preview(token: string): Promise<AgentTransferPreview> {
    if (!tokenPattern.test(token)) throw missing();
    return transaction(this.pool, async db => {
      await this.expireStale(db, "token_hash", digest(token));
      const row = (await db.query(`SELECT t.*,a.name AS agent_name,v.number AS version_number,o.name AS organization_name
        FROM agents_platform.agent_transfers t
        JOIN agents_platform.agents a ON a.id=t.agent_id
        JOIN agents_platform.agent_versions v ON v.id=t.version_id
        JOIN agents_platform.organizations o ON o.id=t.organization_id
        WHERE t.token_hash=$1`, [digest(token)])).rows[0];
      if (!row) throw missing();
      const sources = (await db.query("SELECT title,revision_id FROM agents_platform.agent_transfer_sources WHERE transfer_id=$1 ORDER BY title", [row.id])).rows;
      const revisions = sources.length ? (await db.query("SELECT id,revision FROM agents_platform.source_revisions WHERE id=ANY($1::uuid[])", [sources.map(source => source.revision_id)])).rows : [];
      const revisionNumber = new Map(revisions.map(revision => [revision.id, revision.revision]));
      return {
        agentName: row.agent_name,
        agentVersion: row.version_number,
        organizationName: row.organization_name,
        organizationId: row.organization_id,
        email: maskEmail(row.target_email),
        state: row.state,
        expiresAt: iso(row.expires_at),
        sources: sources.map(source => ({ title: source.title, revision: revisionNumber.get(source.revision_id) ?? 1 })),
        targetOrganizationId: row.target_organization_id ?? null,
        createdAgentId: row.created_agent_id ?? null,
      };
    });
  }

  async decline(accountId: string, token: string): Promise<void> {
    if (!tokenPattern.test(token)) throw missing();
    await transaction(this.pool, async db => {
      await this.expireStale(db, "token_hash", digest(token));
      const transfer = (await db.query("SELECT * FROM agents_platform.agent_transfers WHERE token_hash=$1 FOR UPDATE", [digest(token)])).rows[0];
      if (!transfer) throw missing();
      const account = (await db.query("SELECT email FROM agents_platform.accounts WHERE id=$1", [accountId])).rows[0];
      if (!account || normalizeEmail(account.email) !== normalizeEmail(transfer.target_email)) throw new PlatformError("TRANSFER_EMAIL_MISMATCH", 403, "Sign in with the email address that received this transfer");
      if (transfer.state === "declined") return;
      if (transfer.state !== "pending") throw new PlatformError("TRANSFER_NOT_PENDING", 409, "This transfer is no longer waiting");
      await db.query("UPDATE agents_platform.agent_transfers SET state='declined',target_account_id=$2,settled_at=now(),updated_at=now() WHERE id=$1", [transfer.id, accountId]);
    });
  }

  async accept(accountId: string, token: string, organizationId: string): Promise<{ agentId: string; organizationId: string; alreadyAccepted: boolean }> {
    if (!tokenPattern.test(token)) throw missing();
    return transaction(this.pool, async db => {
      await this.expireStale(db, "token_hash", digest(token));
      const transfer = (await db.query("SELECT * FROM agents_platform.agent_transfers WHERE token_hash=$1 FOR UPDATE", [digest(token)])).rows[0];
      if (!transfer) throw missing();
      const account = (await db.query("SELECT email FROM agents_platform.accounts WHERE id=$1", [accountId])).rows[0];
      if (!account || normalizeEmail(account.email) !== normalizeEmail(transfer.target_email))
        throw new PlatformError("TRANSFER_EMAIL_MISMATCH", 403, "Sign in with the email address that received this transfer");
      if (transfer.state === "accepted") {
        if (transfer.target_account_id !== accountId || !transfer.created_agent_id) throw new PlatformError("TRANSFER_ALREADY_ACCEPTED", 409, "This transfer was already accepted");
        return { agentId: transfer.created_agent_id, organizationId: transfer.target_organization_id, alreadyAccepted: true };
      }
      if (transfer.state !== "pending") throw new PlatformError("TRANSFER_NOT_PENDING", 409, "This transfer is no longer waiting");
      if (organizationId === transfer.organization_id) throw new PlatformError("TRANSFER_DESTINATION_DENIED", 403, "Choose a different workspace");
      const destination = (await db.query("SELECT o.id,o.name,m.role FROM agents_platform.organizations o JOIN agents_platform.memberships m ON m.organization_id=o.id AND m.account_id=$2 AND m.revoked_at IS NULL WHERE o.id=$1 FOR SHARE OF o,m", [organizationId, accountId])).rows[0];
      if (!destination || !["owner", "admin"].includes(destination.role)) throw new PlatformError("TRANSFER_DESTINATION_DENIED", 403, "Choose a workspace you own or administer");
      const agent = (await db.query(`SELECT a.*,v.id AS version_id,v.number AS version_number,v.configuration
        FROM agents_platform.agents a JOIN agents_platform.agent_versions v ON v.id=$3
        WHERE a.organization_id=$1 AND a.id=$2 AND a.deleted_at IS NULL FOR UPDATE OF a`, [transfer.organization_id, transfer.agent_id, transfer.version_id])).rows[0];
      if (!agent) throw new PlatformError("TRANSFER_AGENT_UNAVAILABLE", 409, "The agent is no longer available");
      const current = (await db.query("SELECT id FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1", [transfer.organization_id, transfer.agent_id])).rows[0];
      if (current?.id !== transfer.version_id) throw new PlatformError("TRANSFER_CONFIGURATION_CHANGED", 409, "The agent changed after this transfer was created");
      const sources = (await db.query(`SELECT ts.source_id,ts.revision_id,ts.title,s.state AS source_state,p.state AS policy_state,r.revision,r.raw_key,r.text_key
        FROM agents_platform.agent_transfer_sources ts
        JOIN agents_platform.sources s ON s.organization_id=$2 AND s.id=ts.source_id
        JOIN agents_platform.source_revisions r ON r.organization_id=$2 AND r.id=ts.revision_id
        JOIN agents_platform.source_revision_policy p ON p.organization_id=$2 AND p.revision_id=ts.revision_id
        WHERE ts.transfer_id=$1 ORDER BY s.title,s.id FOR SHARE OF s,r,p`, [transfer.id, transfer.organization_id])).rows;
      const expected = (await db.query("SELECT source_id,revision_id FROM agents_platform.agent_transfer_sources WHERE transfer_id=$1", [transfer.id])).rows;
      if (sources.length !== expected.length || sources.some(source => source.source_state !== "active" || source.policy_state !== "approved"))
        throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "The agent's knowledge changed after this transfer was created");
      const revisionIds = new Map<string, string>();
      const copied: { originalSourceId: string; sourceId: string; revisionId: string }[] = [];
      for (const source of sources) {
        const copy = await this.copySource(db, {
          organizationId: transfer.organization_id, destinationOrganizationId: organizationId, accountId,
          sourceId: source.source_id, revisionId: source.revision_id, title: source.title, transferId: transfer.id,
        });
        revisionIds.set(source.revision_id, copy.revisionId);
        copied.push({ ...copy, originalSourceId: source.source_id });
      }
      const configuration = copiedConfiguration(agentConfigurationSchema.parse(agent.configuration), revisionIds);
      const newAgentId = randomUUID(), versionId = randomUUID(), composition = compilePublishedComposition(configuration, []);
      await db.query(`INSERT INTO agents_platform.agents(id,organization_id,name,avatar,draft,draft_revision,created_by,offering,setup,setup_step)
        VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9)`, [newAgentId, organizationId, agent.name, agent.avatar, configuration, accountId, agent.offering, agent.setup, agent.setup_step]);
      await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,execution_kind,configuration,created_by,draft_revision,tool_bindings,effective_composition)
        VALUES($1,$2,$3,1,$4,$5,$6,1,$7,$8)`, [versionId, organizationId, newAgentId, configuration.executionKind, configuration, accountId, JSON.stringify(publishedToolBindings(configuration)), composition]);
      for (const source of copied) {
        await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) VALUES($1,$2,$3,$4)", [organizationId, versionId, source.sourceId, source.revisionId]);
        await db.query("UPDATE agents_platform.agent_transfer_sources SET copied_source_id=$3,copied_revision_id=$4,state='copied' WHERE transfer_id=$1 AND source_id=$2", [transfer.id, source.originalSourceId, source.sourceId, source.revisionId]);
      }
      await db.query(`UPDATE agents_platform.agent_transfers SET state='accepted',target_account_id=$2,target_organization_id=$3,created_agent_id=$4,settled_at=now(),updated_at=now() WHERE id=$1`,
        [transfer.id, accountId, organizationId, newAgentId]);
      return { agentId: newAgentId, organizationId, alreadyAccepted: false };
    });
  }

  private async copySource(db: PoolClient, input: {
    organizationId: string; destinationOrganizationId: string; accountId: string; sourceId: string; revisionId: string; title: string; transferId: string;
  }): Promise<{ sourceId: string; revisionId: string }> {
    const original = (await db.query(`SELECT s.*,r.id AS revision_id,r.revision,r.raw_key,r.text_key,r.raw_digest,r.text_digest,r.chunk_set_digest,
        r.raw_bytes,r.text_bytes,r.chunk_count,r.parser_release,r.normalizer_release,r.embedding_release,r.embedding_digest,r.acquired_at,
        (SELECT content_type FROM agents_platform.ingestion_jobs WHERE organization_id=s.organization_id AND revision_id=r.id ORDER BY revision DESC LIMIT 1) AS content_type
      FROM agents_platform.sources s
      JOIN agents_platform.source_revisions r ON r.organization_id=s.organization_id AND r.source_id=s.id AND r.id=$3
      JOIN agents_platform.source_revision_policy p ON p.organization_id=s.organization_id AND p.revision_id=r.id AND p.state='approved'
      WHERE s.organization_id=$1 AND s.id=$2 AND s.state='active' FOR SHARE OF s,r,p`, [input.organizationId, input.sourceId, input.revisionId])).rows[0];
    if (!original) throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "The agent's knowledge is unavailable");
    const sourceId = randomUUID(), revisionId = randomUUID(), jobId = randomUUID();
    const rawKey = `knowledge/${input.destinationOrganizationId}/${sourceId}/${revisionId}/raw`;
    const textKey = `knowledge/${input.destinationOrganizationId}/${sourceId}/${revisionId}/${original.text_digest}`;
    let raw: Uint8Array | null = null;
    try { raw = await this.objects.get(original.raw_key, db); }
    catch (error) { if (!(error instanceof PlatformError) || error.code !== "ARTIFACT_CONTENT_MISSING") throw error; }
    const text = await this.objects.get(original.text_key, db);
    const contentType = original.content_type ?? "application/octet-stream";
    if (raw) await this.objects.put(rawKey, raw, contentType, db);
    await this.objects.put(textKey, text, "text/plain; charset=utf-8", db);
    await db.query(`INSERT INTO agents_platform.sources(id,organization_id,importer_account_id,title,kind,generation,state,visibility,created_at,last_verified_at,verified_by,review_due_at)
      VALUES($1,$2,$3,$4,$5,1,'active','public',now(),$6,$7,$8)`,
      [sourceId, input.destinationOrganizationId, input.accountId, input.title, original.kind, original.last_verified_at, original.verified_by, original.review_due_at]);
    await db.query(`INSERT INTO agents_platform.ingestion_jobs(id,organization_id,source_id,importer_account_id,operation_id,request_digest,revision_id,revision,accepted_generation,state,content_type,raw_key,raw_digest,raw_bytes,raw_state,parser_release,embedding_release,deadline,acquired_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,1,1,'ready',$8,$9,$10,$11,$12,$13,$14,now(),$15,now())`,
      [jobId, input.destinationOrganizationId, sourceId, input.accountId, `transfer_${input.transferId}_${input.sourceId}`, original.text_digest,
        revisionId, contentType, rawKey, original.raw_digest, raw ? raw.byteLength : 0, raw ? "available" : "deleted", original.parser_release, original.embedding_release, original.acquired_at]);
    await db.query(`INSERT INTO agents_platform.source_revisions(id,organization_id,source_id,revision,raw_key,text_key,raw_digest,text_digest,chunk_set_digest,raw_bytes,text_bytes,chunk_count,parser_release,normalizer_release,embedding_release,embedding_digest,acquired_at,sealed_at)
      VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
      [revisionId, input.destinationOrganizationId, sourceId, rawKey, textKey, original.raw_digest, original.text_digest, original.chunk_set_digest,
        original.raw_bytes, original.text_bytes, original.chunk_count, original.parser_release, original.normalizer_release, original.embedding_release, original.embedding_digest, original.acquired_at]);
    await db.query("INSERT INTO agents_platform.source_revision_policy(organization_id,source_id,revision_id,state,approved_by,approved_at) VALUES($1,$2,$3,'approved',$4,now())",
      [input.destinationOrganizationId, sourceId, revisionId, input.accountId]);
    if (raw) await this.insertObject(db, input.destinationOrganizationId, jobId, rawKey, "raw", original.raw_digest, raw.byteLength);
    await this.insertObject(db, input.destinationOrganizationId, jobId, textKey, "text", original.text_digest, text.byteLength);
    const sections = (await db.query("SELECT * FROM agents_platform.source_sections WHERE organization_id=$1 AND revision_id=$2 ORDER BY ordinal,part", [input.organizationId, input.revisionId])).rows;
    const sectionIds = new Map<string, string>();
    for (const section of sections) sectionIds.set(section.id, randomUUID());
    if (sections.length) await db.query(`INSERT INTO agents_platform.source_sections(id,organization_id,revision_id,ordinal,parent_ordinal,level,heading,heading_path,part,start_offset,end_offset,chars,content,content_digest)
      SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::integer[],$5::integer[],$6::integer[],$7::text[],$8::text[],$9::integer[],$10::integer[],$11::integer[],$12::integer[],$13::text[],$14::text[])`,
      [sections.map(section => sectionIds.get(section.id)), sections.map(() => input.destinationOrganizationId), sections.map(() => revisionId),
        sections.map(section => section.ordinal), sections.map(section => section.parent_ordinal), sections.map(section => section.level),
        sections.map(section => section.heading), sections.map(section => section.heading_path), sections.map(section => section.part),
        sections.map(section => section.start_offset), sections.map(section => section.end_offset), sections.map(section => section.chars),
        sections.map(section => section.content), sections.map(section => section.content_digest)]);
    const chunks = (await db.query("SELECT * FROM agents_platform.source_chunks WHERE organization_id=$1 AND revision_id=$2 ORDER BY ordinal", [input.organizationId, input.revisionId])).rows;
    const chunkIds = new Map<string, string>();
    for (const chunk of chunks) chunkIds.set(chunk.id, randomUUID());
    if (chunks.length) await db.query(`INSERT INTO agents_platform.source_chunks(id,organization_id,revision_id,ordinal,start_offset,end_offset,page,section,content,content_digest,token_count,section_id,section_ordinal)
      SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::integer[],$5::integer[],$6::integer[],$7::integer[],$8::text[],$9::text[],$10::text[],$11::integer[],$12::uuid[],$13::integer[])`,
      [chunks.map(chunk => chunkIds.get(chunk.id)), chunks.map(() => input.destinationOrganizationId), chunks.map(() => revisionId),
        chunks.map(chunk => chunk.ordinal), chunks.map(chunk => chunk.start_offset), chunks.map(chunk => chunk.end_offset),
        chunks.map(chunk => chunk.page), chunks.map(chunk => chunk.section), chunks.map(chunk => chunk.content),
        chunks.map(chunk => chunk.content_digest), chunks.map(chunk => chunk.token_count),
        chunks.map(chunk => chunk.section_id ? sectionIds.get(chunk.section_id) ?? null : null), chunks.map(chunk => chunk.section_ordinal)]);
    if (chunks.length) {
      const mapped = chunks.map(chunk => [chunk.id, chunkIds.get(chunk.id)!] as const);
      await db.query(`INSERT INTO agents_platform.chunk_embeddings(organization_id,chunk_id,embedding_release,embedding)
        SELECT $1,map.new_id,embedding_release,embedding FROM agents_platform.chunk_embeddings
        JOIN unnest($2::uuid[],$3::uuid[]) AS map(old_id,new_id) ON map.old_id=chunk_embeddings.chunk_id
        WHERE chunk_embeddings.organization_id=$4`, [input.destinationOrganizationId, mapped.map(row => row[0]), mapped.map(row => row[1]), input.organizationId]);
    }
    return { sourceId, revisionId };
  }

  private async insertObject(db: PoolClient, organizationId: string, jobId: string, key: string, kind: "raw" | "text", contentDigest: string, bytes: number): Promise<void> {
    await db.query(`INSERT INTO agents_platform.source_objects(id,organization_id,job_id,object_key,kind,content_digest,bytes,state,write_token,write_attempts,write_lease_until,put_ack_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'available',$8,1,now(),now())`, [randomUUID(), organizationId, jobId, key, kind, contentDigest, bytes, randomUUID()]);
  }
}
