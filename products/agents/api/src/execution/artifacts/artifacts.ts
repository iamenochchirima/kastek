import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { requireMemoryAccess,type ManagementScope } from "../memory/memory";

import { transaction as memoryTransaction } from "../../infrastructure/database";

import { type PrivateObjectStore } from "../../infrastructure/object-store";
const sha=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export interface ArtifactRecord { id: string; contentType: string; bytes: number; contentDigest: string; state: "pending" | "available" | "deleted"; createdAt: string }
const artifact = (row: Record<string, any>): ArtifactRecord => ({ id: row.id, contentType: row.content_type, bytes: row.bytes, contentDigest: row.content_digest, state: row.state, createdAt: row.created_at.toISOString() });
export class ArtifactStore {
  constructor(readonly pool: Pool, readonly objects?: PrivateObjectStore) {}
  async list(scope: ManagementScope): Promise<ArtifactRecord[]> {
    return memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      return (await db.query("SELECT * FROM agents_platform.artifacts WHERE organization_id=$1 AND agent_id=$2 AND account_id=$3 AND task_id IS NULL AND state='available' ORDER BY created_at,id LIMIT 100", [scope.organizationId, scope.agentId, scope.accountId])).rows.map(artifact); });
  }
  async put(scope: ManagementScope, input: { operationId: string; contentType: string; content: Uint8Array }, publication?: {
    taskId:string;rootTaskId:string;name:string;sourceReferences:unknown[];
    validate:(db:PoolClient,artifactId:string)=>Promise<void>;
  }): Promise<ArtifactRecord> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    z.string().min(1).max(128).parse(input.operationId);
    z.enum(["text/plain", "text/markdown", "application/json"]).parse(input.contentType);
    if (input.content.byteLength > 1_048_576) throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit");
    const contentDigest = sha(input.content), requestDigest = sha(JSON.stringify([contentDigest, input.contentType]));
    const row = await memoryTransaction(this.pool, async db => {
      if(publication)await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      await requireMemoryAccess(db, scope);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`artifact:${scope.organizationId}:${scope.agentId}:${scope.accountId}:${input.operationId}`]);
      const old = (await db.query("SELECT * FROM agents_platform.artifacts WHERE organization_id=$1 AND agent_id=$2 AND account_id=$3 AND operation_id=$4", [scope.organizationId, scope.agentId, scope.accountId, input.operationId])).rows[0];
      if (old) { if (old.request_digest !== requestDigest || publication && (old.task_id!==publication.taskId||old.root_task_id!==publication.rootTaskId)) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request key was already used"); if(publication)await publication.validate(db,old.id);return old; }
      const id = randomUUID(), key = `${scope.organizationId}/${scope.agentId}/${scope.accountId}/${id}`;
      const created=(await db.query("INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,operation_id,request_digest,object_key,content_type,bytes,content_digest,state,task_id,root_task_id,name,source_references) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14) RETURNING *", [id, scope.organizationId, scope.agentId, scope.accountId, input.operationId, requestDigest, key, input.contentType, input.content.byteLength, contentDigest,publication?.taskId??null,publication?.rootTaskId??null,publication?.name??null,JSON.stringify(publication?.sourceReferences??[])])).rows[0];
      if(publication)await publication.validate(db,id);return created;
    });
    if (row.state === "deleted") throw new PlatformError("ARTIFACT_DELETED", 410, "Content was deleted");
    if (row.state === "available") return artifact(row);
    // Immutable key and exact payload make a retry safe after a lost PUT response.
    await this.objects.put(row.object_key, input.content, input.contentType);
    let finalized: ArtifactRecord | undefined;
    try { finalized = await memoryTransaction(this.pool, async db => {
      if(publication)await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      await requireMemoryAccess(db, scope);
      const current = (await db.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (current.state === "deleted") return undefined;
      if(publication)await publication.validate(db,current.id);
      if (current.state === "available") return artifact(current);
      return artifact((await db.query("UPDATE agents_platform.artifacts SET state='available' WHERE id=$1 RETURNING *", [row.id])).rows[0]);
    }); } catch (error) {
      if (error instanceof PlatformError && (error.code === "ACCESS_DENIED" || publication)) {
        await this.pool.query("UPDATE agents_platform.artifacts SET state='deleted' WHERE id=$1", [row.id]);
        await this.objects.delete(row.object_key);
      }
      throw error;
    }
    if (!finalized) { await this.objects.delete(row.object_key); throw new PlatformError("ARTIFACT_DELETED", 410, "Content was deleted"); }
    return finalized;
  }
  async get(scope: ManagementScope, artifactId: string, allowTaskArtifact = false): Promise<{ artifact: ArtifactRecord; content: Uint8Array }> {
    z.uuid().parse(artifactId);
    const row = await memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      const value = (await db.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND account_id=$4 AND state='available'", [artifactId, scope.organizationId, scope.agentId, scope.accountId])).rows[0];
      if (!value || (value.task_id && !allowTaskArtifact)) throw new PlatformError("NOT_FOUND", 404, "Content not found"); return value; });
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    const content = await this.objects.get(row.object_key);
    if (sha(content) !== row.content_digest || content.byteLength !== row.bytes) throw new PlatformError("ARTIFACT_INTEGRITY", 502, "Content integrity check failed");
    await memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      if (!(await db.query("SELECT 1 FROM agents_platform.artifacts WHERE id=$1 AND state='available'", [row.id])).rowCount) throw new PlatformError("NOT_FOUND", 404, "Content not found"); });
    return { artifact: artifact(row), content };
  }
  async forget(scope: ManagementScope, artifactId: string) {
    z.uuid().parse(artifactId);
    const row = await memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      const value = (await db.query("UPDATE agents_platform.artifacts SET state='deleted' WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND account_id=$4 AND task_id IS NULL RETURNING *", [artifactId, scope.organizationId, scope.agentId, scope.accountId])).rows[0];
      if (!value) throw new PlatformError("NOT_FOUND", 404, "Content not found"); return value; });
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    await this.objects.delete(row.object_key); return artifact(row);
  }
}
