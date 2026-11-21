import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { requireMemoryAccess } from "../memory/access";
import type { ManagementScope } from "../../contracts/memory";

import { transaction as memoryTransaction } from "../../infrastructure/database";

import { type PrivateObjectStore } from "../../infrastructure/object-store";
import { productPorts } from "../../infrastructure/product-ports";
const sha=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export interface ProductTaskArtifactScope { namespace:"product_task"; product:"growth"|"agencies"; organizationId:string; agentId:string; taskId:string }
export type ArtifactOwner = ManagementScope | ProductTaskArtifactScope;
function isProduct(scope:ArtifactOwner):scope is ProductTaskArtifactScope{return "namespace" in scope&&scope.namespace==="product_task";}
async function requireArtifactAccess(db:PoolClient,scope:ArtifactOwner):Promise<void>{
  if(!isProduct(scope)){await requireMemoryAccess(db,scope);return;}
  if(!(await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id
    WHERE t.id=$1 AND t.product=$2 AND t.organization_id=$3 AND v.agent_id=$4`,[scope.taskId,scope.product,scope.organizationId,scope.agentId])).rowCount)
    throw new PlatformError("ACCESS_DENIED",403,"Artifact access is unavailable");
  const ports=productPorts(db);
  if(!ports.assertCurrentOrigin)throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE",503,"Product artifact authorization is unavailable");
  await ports.assertCurrentOrigin(db,scope.taskId);
}
export interface ArtifactRecord { id: string; contentType: string; bytes: number; contentDigest: string; state: "pending" | "available" | "deleted"; createdAt: string }
const artifact = (row: Record<string, any>): ArtifactRecord => ({ id: row.id, contentType: row.content_type, bytes: row.bytes, contentDigest: row.content_digest, state: row.state, createdAt: row.created_at.toISOString() });
export class ArtifactStore {
  constructor(readonly pool: Pool, readonly objects?: PrivateObjectStore) {}
  async list(scope: ManagementScope): Promise<ArtifactRecord[]> {
    return memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      return (await db.query("SELECT * FROM agents_platform.artifacts WHERE organization_id=$1 AND agent_id=$2 AND account_id=$3 AND task_id IS NULL AND state='available' ORDER BY created_at,id LIMIT 100", [scope.organizationId, scope.agentId, scope.accountId])).rows.map(artifact); });
  }
  async put(scope: ArtifactOwner, input: { operationId: string; contentType: string; content: Uint8Array }, publication?: {
    taskId:string;rootTaskId:string;name:string;sourceReferences:unknown[];
    validate:(db:PoolClient,artifactId:string,phase:"prepare"|"available")=>Promise<void>;
  }): Promise<ArtifactRecord> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    z.string().min(1).max(128).parse(input.operationId);
    z.enum(["text/plain", "text/markdown", "application/json"]).parse(input.contentType);
    if (input.content.byteLength > 1_048_576) throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit");
    if(isProduct(scope)&&(!publication||publication.taskId!==scope.taskId))throw new PlatformError("ACCESS_DENIED",403,"Artifact access is unavailable");
    const contentDigest = sha(input.content), requestDigest = sha(JSON.stringify(isProduct(scope)?[contentDigest,input.contentType,publication!.name]:[contentDigest, input.contentType]));
    const row = await memoryTransaction(this.pool, async db => {
      if(publication)await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      await requireArtifactAccess(db, scope);
      const ownerKey=isProduct(scope)?`${scope.product}:${scope.taskId}`:scope.accountId;
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`artifact:${scope.organizationId}:${scope.agentId}:${ownerKey}:${input.operationId}`]);
      const old = isProduct(scope)?(await db.query("SELECT * FROM agents_platform.artifacts WHERE product_owner=$1 AND organization_id=$2 AND task_id=$3 AND operation_id=$4",[scope.product,scope.organizationId,scope.taskId,input.operationId])).rows[0]:
        (await db.query("SELECT * FROM agents_platform.artifacts WHERE organization_id=$1 AND agent_id=$2 AND account_id=$3 AND operation_id=$4", [scope.organizationId, scope.agentId, scope.accountId, input.operationId])).rows[0];
      if (old) { if (old.request_digest !== requestDigest || publication && (old.task_id!==publication.taskId||old.root_task_id!==publication.rootTaskId)) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request key was already used"); if(publication)await publication.validate(db,old.id,old.state==="available"?"available":"prepare");return old; }
      const id = randomUUID(), key = isProduct(scope)?`${scope.organizationId}/${scope.agentId}/${scope.product}/${scope.taskId}/${id}`:`${scope.organizationId}/${scope.agentId}/${scope.accountId}/${id}`;
      const created=(await db.query("INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,operation_id,request_digest,object_key,content_type,bytes,content_digest,state,task_id,root_task_id,name,source_references,product_owner) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,$12,$13,$14,$15) RETURNING *", [id, scope.organizationId, scope.agentId, isProduct(scope)?null:scope.accountId, input.operationId, requestDigest, key, input.contentType, input.content.byteLength, contentDigest,publication?.taskId??null,publication?.rootTaskId??null,publication?.name??null,JSON.stringify(publication?.sourceReferences??[]),isProduct(scope)?scope.product:null])).rows[0];
      if(publication)await publication.validate(db,id,"prepare");return created;
    });
    if (row.state === "deleted") throw new PlatformError("ARTIFACT_DELETED", 410, "Content was deleted");
    if (row.state === "available") return artifact(row);
    // Immutable key and exact payload make a retry safe after a lost PUT response.
    await this.objects.put(row.object_key, input.content, input.contentType);
    let finalized: ArtifactRecord | undefined;
    try { finalized = await memoryTransaction(this.pool, async db => {
      if(publication)await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      await requireArtifactAccess(db, scope);
      const current = (await db.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (current.state === "deleted") return undefined;
      const available=current.state==="available"?current:(await db.query("UPDATE agents_platform.artifacts SET state='available' WHERE id=$1 RETURNING *", [row.id])).rows[0];
      if(publication)await publication.validate(db,current.id,"available");
      return artifact(available);
    }); } catch (error) {
      if (error instanceof PlatformError && (error.code === "ACCESS_DENIED" || publication)) {
        const deleted=await this.pool.query("UPDATE agents_platform.artifacts SET state='deleted' WHERE id=$1 AND state='pending' RETURNING id", [row.id]);
        if(deleted.rowCount)await this.objects.delete(row.object_key);
      }
      throw error;
    }
    if (!finalized) { await this.objects.delete(row.object_key); throw new PlatformError("ARTIFACT_DELETED", 410, "Content was deleted"); }
    return finalized;
  }
  async getProduct(scope:ProductTaskArtifactScope,artifactId:string):Promise<{artifact:ArtifactRecord;content:Uint8Array}>{
    z.uuid().parse(artifactId);
    const read=async(db:PoolClient)=>{
      await requireArtifactAccess(db,scope);
      const row=(await db.query(`SELECT * FROM agents_platform.artifacts WHERE id=$1 AND organization_id=$2 AND agent_id=$3
        AND task_id=$4 AND product_owner=$5 AND account_id IS NULL AND state='available'`,
        [artifactId,scope.organizationId,scope.agentId,scope.taskId,scope.product])).rows[0];
      if(!row)throw new PlatformError("NOT_FOUND",404,"Content not found");return row;
    };
    const row=await transactionForArtifact(this.pool,read);
    if(!this.objects)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    const content=await this.objects.get(row.object_key);
    if(content.byteLength!==row.bytes||sha(content)!==row.content_digest)throw new PlatformError("ARTIFACT_INTEGRITY",502,"Content integrity check failed");
    const after=await transactionForArtifact(this.pool,read);
    if(after.object_key!==row.object_key||after.content_digest!==row.content_digest||after.bytes!==row.bytes)throw new PlatformError("ARTIFACT_INTEGRITY",502,"Content integrity check failed");
    return {artifact:artifact(after),content};
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
const transactionForArtifact=memoryTransaction;
