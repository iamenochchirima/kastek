import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {transaction as memoryTransaction} from "./database";
import { z } from "zod";
import { PlatformError, type InitiatingPrincipal } from "./contracts";

export interface MemoryScope { organizationId: string; agentId: string; principal: InitiatingPrincipal }
export interface ManagementScope { accountId: string; organizationId: string; agentId: string }
export interface ScopeReference extends ManagementScope { id: string; generation: number }
export interface MemoryRecord { id: string; kind: "semantic" | "episodic"; content: string; status: "candidate" | "accepted" | "forgotten"; revision: number; sourceTaskId: string | null; expiresAt: string | null; createdAt: string; updatedAt: string }
export interface SkillRevision { id: string; name: string; description: string; body: string; revision: number; contentDigest: string; createdAt: string }
const schema = "agents_platform";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const contentSchema = z.string().trim().min(1).max(8192).refine(value => Buffer.byteLength(value) <= 8192);
const operationSchema = z.string().min(1).max(128);
const idSchema = z.uuid();
const record = (row: Record<string, any>): MemoryRecord => ({ id: row.id, kind: row.kind, content: row.content, status: row.status,
  revision: row.revision, sourceTaskId: row.source_task_id, expiresAt: row.expires_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const skill = (row: Record<string, any>): SkillRevision => ({ id: row.id, name: row.name, description: row.description, body: row.body,
  revision: row.revision, contentDigest: row.content_digest, createdAt: row.created_at.toISOString() });

export async function requireMemoryAccess(db: PoolClient, scope: ManagementScope): Promise<void> {
  idSchema.parse(scope.accountId); idSchema.parse(scope.organizationId); idSchema.parse(scope.agentId);
  const access = await db.query(`SELECT 1 FROM ${schema}.memberships m JOIN ${schema}.agents a ON a.organization_id=m.organization_id
    WHERE m.organization_id=$1 AND m.account_id=$2 AND m.revoked_at IS NULL AND a.id=$3 FOR SHARE OF m`,
  [scope.organizationId, scope.accountId, scope.agentId]);
  if (!access.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access is unavailable");
}
export class MemoryStore {
  constructor(readonly pool: Pool) {}
  async resolveHuman(db: PoolClient, scope: MemoryScope): Promise<ManagementScope> {
    if (scope.principal.kind !== "human") throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "Personal memory requires a verified user");
    const account = (await db.query(`SELECT id FROM ${schema}.accounts WHERE issuer=$1 AND subject=$2`, [scope.principal.issuer, scope.principal.subject])).rows[0];
    if (!account) throw new PlatformError("ACCESS_DENIED", 403, "Access is unavailable");
    const resolved = { accountId: account.id as string, organizationId: scope.organizationId, agentId: scope.agentId };
    await requireMemoryAccess(db, resolved); return resolved;
  }
  async namespace(db: PoolClient, scope: ManagementScope, _mutation = false): Promise<ScopeReference> {
    await requireMemoryAccess(db, scope);
    await db.query(`INSERT INTO ${schema}.memory_scopes(id,organization_id,agent_id,account_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [randomUUID(), scope.organizationId, scope.agentId, scope.accountId]);
    const row = (await db.query(`SELECT id,generation,next_expiry_at FROM ${schema}.memory_scopes WHERE organization_id=$1 AND agent_id=$2 AND account_id=$3 FOR UPDATE`,
      [scope.organizationId, scope.agentId, scope.accountId])).rows[0];
    if (row.next_expiry_at && new Date(row.next_expiry_at).getTime() <= Date.now()) {
      const refreshed = (await db.query(`UPDATE ${schema}.memory_scopes SET generation=generation+1,
        next_expiry_at=(SELECT min(expires_at) FROM ${schema}.memories WHERE scope_id=$1 AND status='accepted' AND expires_at>now())
        WHERE id=$1 RETURNING generation`, [row.id])).rows[0];
      row.generation = refreshed.generation;
    }
    return { ...scope, id: row.id, generation: Number(row.generation) };
  }
  async read(scope: MemoryScope, query?: string) {
    return memoryTransaction(this.pool, async db => this.readResolved(db, await this.resolveHuman(db, scope), query, false));
  }
  async list(scope: ManagementScope) { return memoryTransaction(this.pool, db => this.readResolved(db, scope, undefined, true)); }
  private async readResolved(db: PoolClient, scope: ManagementScope, query: string | undefined, management: boolean) {
    const ref = await this.namespace(db, scope);
    if (query !== undefined) z.string().max(2048).parse(query);
    const rows = (await db.query(`SELECT * FROM ${schema}.memories WHERE scope_id=$1 AND status IN ${management ? "('accepted','candidate')" : "('accepted')"}
      AND (expires_at IS NULL OR expires_at>now()) AND ($2::text IS NULL OR to_tsvector('simple',content) @@ plainto_tsquery('simple',$2))
      ORDER BY CASE WHEN $2::text IS NULL THEN 0 ELSE ts_rank(to_tsvector('simple',content),plainto_tsquery('simple',$2)) END DESC,created_at,id LIMIT 100`, [ref.id, query?.trim() || null])).rows.map(record);
    return { scope: ref, generation: ref.generation, memories: rows.filter(row => row.status === "accepted"), candidates: rows.filter(row => row.status === "candidate") };
  }
  async propose(scope: MemoryScope, input: { operationId: string; kind: "semantic" | "episodic"; content: string; sourceTaskId?: string; expiresAt?: string }) {
    return memoryTransaction(this.pool, async db => this.proposeResolved(db, await this.resolveHuman(db, scope), input));
  }
  async proposeManaged(scope: ManagementScope, input: { operationId: string; kind: "semantic" | "episodic"; content: string; sourceTaskId?: string; expiresAt?: string }) {
    return memoryTransaction(this.pool, db => this.proposeResolved(db, scope, input));
  }
  private async replay(db: PoolClient, ref: ScopeReference, operationId: string, requestDigest: string): Promise<MemoryRecord | undefined> {
    const old = (await db.query(`SELECT o.request_digest,m.* FROM ${schema}.memory_mutations o JOIN ${schema}.memories m ON m.id=o.memory_id WHERE o.scope_id=$1 AND o.operation_id=$2`, [ref.id, operationId])).rows[0];
    if (!old) return;
    if (old.request_digest !== requestDigest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request key was already used");
    return record(old);
  }
  private async save(db: PoolClient, ref: ScopeReference, operationId: string, requestDigest: string, row: Record<string, any>) {
    await db.query(`INSERT INTO ${schema}.memory_revisions(memory_id,revision,content,content_digest,status) VALUES($1,$2,$3,$4,$5)`, [row.id, row.revision, row.content, row.content_digest, row.status]);
    await db.query(`INSERT INTO ${schema}.memory_mutations(scope_id,operation_id,request_digest,memory_id) VALUES($1,$2,$3,$4)`, [ref.id, operationId, requestDigest, row.id]);
    if (row.status !== "candidate") await db.query(`UPDATE ${schema}.memory_scopes SET generation=generation+1,
      next_expiry_at=(SELECT min(expires_at) FROM ${schema}.memories WHERE scope_id=$1 AND status='accepted' AND expires_at>now()) WHERE id=$1`, [ref.id]);
    return record(row);
  }
  private async proposeResolved(db: PoolClient, scope: ManagementScope, input: { operationId: string; kind: "semantic" | "episodic"; content: string; sourceTaskId?: string; expiresAt?: string }) {
    const parsed = z.strictObject({ operationId: operationSchema, kind: z.enum(["semantic", "episodic"]), content: contentSchema, sourceTaskId: idSchema.optional(), expiresAt: z.iso.datetime().optional() }).parse(input);
    await requireMemoryAccess(db, scope);
    if (parsed.sourceTaskId) {
      const task = (await db.query(`SELECT t.principal FROM ${schema}.tasks t JOIN ${schema}.conversations c ON c.id=t.conversation_id AND c.organization_id=t.organization_id WHERE t.id=$1 AND t.organization_id=$2 AND t.resource_id=$3 AND c.deleted_at IS NULL FOR KEY SHARE OF t`, [parsed.sourceTaskId, scope.organizationId, scope.agentId])).rows[0];
      const account = (await db.query(`SELECT issuer,subject FROM ${schema}.accounts WHERE id=$1`, [scope.accountId])).rows[0];
      if (!task || task.principal.kind !== "human" || task.principal.issuer !== account.issuer || task.principal.subject !== account.subject) throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "Source task is unavailable");
    }
    const ref = await this.namespace(db, scope, true), requestDigest = digest(JSON.stringify(parsed));
    const old = await this.replay(db, ref, parsed.operationId, requestDigest); if (old) return old;
    if (parsed.expiresAt && new Date(parsed.expiresAt).getTime() <= Date.now()) throw new PlatformError("INVALID_INPUT", 400, "Memory expiry must be in the future");
    const contentDigest = digest(parsed.content);
    if ((await db.query(`SELECT 1 FROM ${schema}.memory_suppressions WHERE scope_id=$1 AND content_digest=$2`, [ref.id, contentDigest])).rowCount) throw new PlatformError("MEMORY_SUPPRESSED", 409, "This memory was forgotten");

    const row = (await db.query(`INSERT INTO ${schema}.memories(id,scope_id,kind,status,content,content_digest,source_task_id,expires_at) VALUES($1,$2,$3,'candidate',$4,$5,$6,$7) RETURNING *`,
      [randomUUID(), ref.id, parsed.kind, parsed.content, contentDigest, parsed.sourceTaskId ?? null, parsed.expiresAt ?? null])).rows[0];
    return this.save(db, ref, parsed.operationId, requestDigest, row);
  }
  async mutate(scope: ManagementScope, memoryId: string, input: { operationId: string; expectedRevision: number; action: "accept" | "correct" | "forget"; content?: string }) {
    idSchema.parse(memoryId);
    const parsed = z.strictObject({ operationId: operationSchema, expectedRevision: z.number().int().positive(), action: z.enum(["accept", "correct", "forget"]), content: contentSchema.optional() }).parse(input);
    if (parsed.action === "correct" && !parsed.content) throw new PlatformError("INVALID_INPUT", 400, "Enter the corrected memory");
    return memoryTransaction(this.pool, async db => {
      const ref = await this.namespace(db, scope, true), requestDigest = digest(JSON.stringify({ memoryId, ...parsed }));
      const old = await this.replay(db, ref, parsed.operationId, requestDigest); if (old) return old;
      const current = (await db.query(`SELECT * FROM ${schema}.memories WHERE id=$1 AND scope_id=$2 FOR UPDATE`, [memoryId, ref.id])).rows[0];
      if (!current) throw new PlatformError("NOT_FOUND", 404, "Memory not found");
      if (current.revision !== parsed.expectedRevision) throw new PlatformError("MEMORY_CONFLICT", 409, "Memory changed; reload and try again");
      if (current.status === "forgotten" || (parsed.action === "accept" && current.status !== "candidate")) throw new PlatformError("MEMORY_CONFLICT", 409, "Memory cannot be changed");
      if (parsed.action === "forget") await db.query(`INSERT INTO ${schema}.memory_suppressions(scope_id,content_digest) SELECT $1,content_digest FROM ${schema}.memory_revisions WHERE memory_id=$2 ON CONFLICT DO NOTHING`, [ref.id, memoryId]);
      const content = parsed.action === "forget" ? "" : parsed.content ?? current.content;
      if (parsed.action === "correct" && (await db.query(`SELECT 1 FROM ${schema}.memory_suppressions WHERE scope_id=$1 AND content_digest=$2`, [ref.id, digest(content)])).rowCount) throw new PlatformError("MEMORY_SUPPRESSED", 409, "This memory was forgotten");
      const row = (await db.query(`UPDATE ${schema}.memories SET content=$3,content_digest=$4,status=$5,revision=revision+1,updated_at=now() WHERE id=$1 AND scope_id=$2 RETURNING *`,
        [memoryId, ref.id, content, digest(content), parsed.action === "forget" ? "forgotten" : "accepted"])).rows[0];
      return this.save(db, ref, parsed.operationId, requestDigest, row);
    });
  }
  async deleteConversationSources(scope: ManagementScope, conversationId: string): Promise<{ deleted: true; taskIds: string[] }> {
    idSchema.parse(conversationId);
    return memoryTransaction(this.pool, async db => {
      await requireMemoryAccess(db, scope);
      const account = (await db.query(`SELECT issuer,subject FROM ${schema}.accounts WHERE id=$1`, [scope.accountId])).rows[0];
      const principal = { kind: "human", issuer: account.issuer, subject: account.subject };
      const owned = (await db.query(`SELECT id FROM ${schema}.conversations WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND principal=$4::jsonb`,
        [conversationId, scope.organizationId, scope.agentId, JSON.stringify(principal)])).rowCount;
      if (!owned) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
      // Match operation admission ordering: tasks, conversation, then memory namespace.
      const tasks = (await db.query(`SELECT id FROM ${schema}.tasks WHERE conversation_id=$1 ORDER BY id FOR UPDATE`, [conversationId])).rows;
      const conversation = (await db.query(`SELECT id,deleted_at FROM ${schema}.conversations WHERE id=$1 FOR UPDATE`, [conversationId])).rows[0];
      if (conversation.deleted_at) return { deleted: true as const, taskIds: tasks.map(row => row.id as string) };
      const ref = await this.namespace(db, scope, true);
      await db.query(`UPDATE ${schema}.conversations SET deleted_at=coalesce(deleted_at,now()) WHERE id=$1`, [conversationId]);
      await db.query(`UPDATE ${schema}.tasks SET state='cancel_requested',updated_at=now() WHERE conversation_id=$1 AND state IN ('accepted','running','waiting_authority')`, [conversationId]);
      for (const task of tasks) await db.query(`INSERT INTO ${schema}.task_events(task_id,event_key,kind) VALUES($1,$2,'source.deleted') ON CONFLICT(task_id,event_key) DO NOTHING`, [task.id, `source-delete:${conversationId}`]);
      const linked = (await db.query(`SELECT m.* FROM ${schema}.memories m JOIN ${schema}.tasks t ON t.id=m.source_task_id WHERE m.scope_id=$1 AND t.conversation_id=$2 AND m.status<>'forgotten' FOR UPDATE OF m`, [ref.id, conversationId])).rows;
      for (const current of linked) {
        await db.query(`INSERT INTO ${schema}.memory_suppressions(scope_id,content_digest) SELECT $1,content_digest FROM ${schema}.memory_revisions WHERE memory_id=$2 ON CONFLICT DO NOTHING`, [ref.id, current.id]);
        const row = (await db.query(`UPDATE ${schema}.memories SET content='',content_digest=$2,status='forgotten',revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`, [current.id, digest("")])).rows[0];
        await this.save(db, ref, `source-delete:${conversationId}:${current.id}`, digest(JSON.stringify([conversationId,current.id])), row);
      }
      if (!linked.length) await db.query(`UPDATE ${schema}.memory_scopes SET generation=generation+1 WHERE id=$1`, [ref.id]);
      return { deleted: true as const, taskIds: tasks.map(row => row.id as string) };
    });
  }
  async listSkills(accountId: string, organizationId: string, agentId: string): Promise<SkillRevision[]> {
    return memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, { accountId, organizationId, agentId });
      return (await db.query(`SELECT * FROM ${schema}.skill_revisions WHERE organization_id=$1 AND agent_id=$2 ORDER BY name,revision DESC`, [organizationId, agentId])).rows.map(skill); });
  }
  async readSkills(scope: MemoryScope, skillIds: string[]): Promise<SkillRevision[]> {
    z.array(idSchema).max(8).parse(skillIds);
    return memoryTransaction(this.pool, async db => { const resolved = await this.resolveHuman(db, scope);
      const rows = (await db.query(`SELECT * FROM ${schema}.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND id=ANY($3::uuid[]) ORDER BY id`, [resolved.organizationId, resolved.agentId, skillIds])).rows;
      if (rows.length !== new Set(skillIds).size) throw new PlatformError("SKILL_SCOPE_DENIED", 403, "Skill is unavailable");
      return rows.map(skill); });
  }
  async publishSkill(scope: ManagementScope, input: { operationId: string; name: string; description: string; body: string }): Promise<SkillRevision> {
    const parsed = z.strictObject({ operationId: operationSchema, name: z.string().trim().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), description: z.string().trim().min(1).max(1024).refine(value => Buffer.byteLength(value)<=1024), body: z.string().trim().min(1).max(16384).refine(value => Buffer.byteLength(value)<=16384) }).parse(input);
    return memoryTransaction(this.pool, async db => {
      await this.namespace(db, scope, true); const requestDigest = digest(JSON.stringify(parsed));
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`skill:${scope.organizationId}:${scope.agentId}`]);
      const old = (await db.query(`SELECT * FROM ${schema}.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND operation_id=$3`, [scope.organizationId, scope.agentId, parsed.operationId])).rows[0];
      if (old) { if (old.request_digest !== requestDigest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request key was already used"); return skill(old); }
      const revision = Number((await db.query(`SELECT coalesce(max(revision),0)+1 AS next FROM ${schema}.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND name=$3`, [scope.organizationId, scope.agentId, parsed.name])).rows[0].next);
      const row = (await db.query(`INSERT INTO ${schema}.skill_revisions(id,organization_id,agent_id,created_by,name,description,body,revision,content_digest,operation_id,request_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [randomUUID(), scope.organizationId, scope.agentId, scope.accountId, parsed.name, parsed.description, parsed.body, revision, digest(JSON.stringify([parsed.name, parsed.description, parsed.body])), parsed.operationId, requestDigest])).rows[0];
      return skill(row);
    });
  }
}
