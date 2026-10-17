import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ArtifactStore, type PrivateObjectStore } from "./artifacts";
import { canonicalJson, PlatformError } from "./contracts";
import { transaction } from "./database";
import { assertCurrentAuthority, loadExecution } from "./execution";
import type { ManagementScope } from "./memory";

const outputSchema = z.strictObject({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/),
  contentType: z.enum(["text/plain", "text/markdown", "application/json"]) });
const missing = () => new PlatformError("ARTIFACT_NOT_FOUND", 404, "Artifact not found");
export interface TaskArtifact { id: string; taskId: string; rootTaskId: string; name: string; contentType: string;
  bytes: number; contentDigest: string; createdAt: Date; sourceReferences: unknown[] }
function dto(row: Record<string, any>): TaskArtifact {
  return { id: row.id, taskId: row.task_id, rootTaskId: row.root_task_id, name: row.name,
    contentType: row.content_type, bytes: row.bytes, contentDigest: row.content_digest,
    createdAt: row.created_at, sourceReferences: row.source_references };
}
export class TaskArtifactStore {
  private readonly artifacts: ArtifactStore;
  constructor(readonly pool: Pool, readonly objects?: PrivateObjectStore) { this.artifacts = new ArtifactStore(pool, objects); }
  private async owner(db: Pool | PoolClient, taskId: string): Promise<{ task: Record<string, any>; scope: ManagementScope }> {
    const task = (await db.query(`SELECT t.*,v.agent_id,a.id AS account_id,c.deleted_at AS source_deleted
      FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id
      JOIN agents_platform.accounts a ON a.issuer=t.principal->>'issuer' AND a.subject=t.principal->>'subject'
      JOIN agents_platform.conversations c ON c.id=t.conversation_id
      JOIN agents_platform.memberships m ON m.organization_id=t.organization_id AND m.account_id=a.id AND m.revoked_at IS NULL
      WHERE t.id=$1 AND t.principal->>'kind'='human'`, [taskId])).rows[0];
    if (!task || task.source_deleted) throw missing();
    const root = (await db.query(`SELECT t.principal,c.deleted_at,g.revoked_at FROM agents_platform.tasks t
      JOIN agents_platform.conversations c ON c.id=t.conversation_id JOIN agents_platform.execution_grants g ON g.id=t.grant_id
      WHERE t.id=$1 AND t.organization_id=$2`, [task.root_task_id,task.organization_id])).rows[0];
    if (!root || root.deleted_at || root.revoked_at || canonicalJson(root.principal)!==canonicalJson(task.principal)) throw missing();
    return { task, scope: { accountId: task.account_id, organizationId: task.organization_id, agentId: task.agent_id } };
  }
  async put(taskId: string, operationId: string, input: { name: string; contentType: string; content: Uint8Array; sourceReferences?: unknown[] }): Promise<TaskArtifact> {
    const meta = outputSchema.parse({ name: input.name, contentType: input.contentType });
    if(input.content.byteLength>1_048_576) throw new PlatformError("ARTIFACT_TOO_LARGE",413,"Content exceeds the storage limit");
    const owner = await transaction(this.pool,async db=>{
      const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.write")) throw new PlatformError("ARTIFACT_SCOPE_DENIED",403,"Artifact access is unavailable");
      if(!(await db.query("SELECT id FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND name='sandbox.analyze' AND state IN ('started','completed')",[operationId,taskId])).rowCount) throw missing();
      return this.owner(db,taskId);
    });
    const key=createHash("sha256").update(canonicalJson([taskId,operationId,meta])).digest("hex");
    const artifact=await this.artifacts.put(owner.scope,{operationId:`task:${key}`,contentType:meta.contentType,content:input.content});
    return transaction(this.pool,async db=>{
      const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);await this.owner(db,taskId);
      const row=(await db.query(`UPDATE agents_platform.artifacts SET task_id=$2,root_task_id=$3,name=$4,source_references=$5
        WHERE id=$1 AND (task_id IS NULL OR task_id=$2) AND state='available' RETURNING *`,
      [artifact.id,taskId,owner.task.root_task_id,meta.name,JSON.stringify(input.sourceReferences??[])])).rows[0];
      if(!row) throw missing();return dto(row);
    });
  }
  async listForRoot(rootTaskId:string):Promise<TaskArtifact[]> {
    await this.owner(this.pool,rootTaskId);
    return (await this.pool.query(`SELECT a.* FROM agents_platform.artifacts a JOIN agents_platform.tasks t ON t.id=a.task_id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE a.root_task_id=$1 AND a.state='available'
      AND c.deleted_at IS NULL ORDER BY a.created_at,a.id LIMIT 100`,[rootTaskId])).rows.map(dto);
  }
  async readForTask(taskId:string,artifactId:string):Promise<{artifact:TaskArtifact;content:Uint8Array}> {
    z.uuid().parse(artifactId);
    const actor=await transaction(this.pool,async db=>{const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.read"))throw missing();return this.owner(db,taskId);});
    return this.read(actor.task,artifactId);
  }
  private async read(task:Record<string,any>,artifactId:string):Promise<{artifact:TaskArtifact;content:Uint8Array}> {
    const row=(await this.pool.query(`SELECT a.* FROM agents_platform.artifacts a WHERE a.id=$1 AND a.root_task_id=$2 AND a.state='available'
      AND (a.task_id=$3 OR $3=$2 OR EXISTS(SELECT 1 FROM agents_platform.task_artifact_transfers x WHERE x.artifact_id=a.id AND x.target_task_id=$3))`,
    [artifactId,task.root_task_id,task.id])).rows[0];
    if(!row)throw missing();const producer=await this.owner(this.pool,row.task_id);
    for(const reference of row.source_references as {kind?:string;id?:string}[]) {
      if(reference.kind==="artifact" && reference.id) {
        const source=(await this.pool.query("SELECT task_id,state FROM agents_platform.artifacts WHERE id=$1 AND root_task_id=$2",[reference.id,task.root_task_id])).rows[0];
        if(!source||source.state!=="available")throw missing();await this.owner(this.pool,source.task_id);
      }
    }
    const result=await this.artifacts.get(producer.scope,artifactId,true);
    await this.owner(this.pool,task.id);await this.owner(this.pool,row.task_id);
    return {artifact:dto(row),content:result.content};
  }
  async download(accountId:string,organizationId:string,taskId:string,artifactId:string) {
    const actor=await this.owner(this.pool,taskId);
    if(actor.scope.accountId!==accountId||actor.scope.organizationId!==organizationId)throw missing();
    return this.read(actor.task,z.uuid().parse(artifactId));
  }
  async transfer(parentTaskId:string,targetTaskId:string,artifactId:string):Promise<void> {
    await this.readForTask(parentTaskId,artifactId);
    await transaction(this.pool,async db=>{
      const parent=await loadExecution(db,parentTaskId,true);await assertCurrentAuthority(db,parent);
      const child=await this.owner(db,targetTaskId);
      if(child.task.parent_task_id!==parentTaskId||child.task.root_task_id!==(parent.task as any).root_task_id)throw missing();
      await db.query(`INSERT INTO agents_platform.task_artifact_transfers(artifact_id,target_task_id,granted_by_task_id)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[artifactId,targetTaskId,parentTaskId]);
    });
  }
}
