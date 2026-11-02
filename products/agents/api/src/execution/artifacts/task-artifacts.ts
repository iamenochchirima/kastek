import { createHash } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson,PlatformError } from "../../contracts/contracts";
import type { DependencyManifest } from "../../contracts/source-contracts";
import { transaction } from "../../infrastructure/database";
import { type PrivateObjectStore } from "../../infrastructure/object-store";
import { assertCurrentEvidence,EvidenceStore,taskEvidenceManifest } from "../context/evidence";
import { resolveAutomationOwner,resolveAutomationReviewer } from "../lifecycle/automation-authority";
import { assertCurrentAuthority,loadExecution } from "../lifecycle/execution";
import type { ManagementScope } from "../memory/memory";
import { ArtifactStore } from "./artifacts";

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
  readonly evidence?:EvidenceStore;
  constructor(readonly pool: Pool, readonly objects?: PrivateObjectStore) { this.artifacts = new ArtifactStore(pool, objects);this.evidence=objects?new EvidenceStore(pool,objects):undefined; }
  async assertEvidence(db:Pool|PoolClient,taskId:string,artifactId:string):Promise<DependencyManifest>{
    if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    return this.evidence.artifactManifest(db,taskId,artifactId);
  }
  async validateReport(taskId:string,artifactId:string,content:string){
    if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    await this.assertEvidence(this.pool,taskId,artifactId);return this.evidence.validateReport(taskId,artifactId,content);
  }
  private async owner(db: Pool | PoolClient, taskId: string): Promise<{ task: Record<string, any>; scope: ManagementScope }> {
    const task = (await db.query(`SELECT t.*,v.agent_id,a.id AS account_id,c.deleted_at AS source_deleted
      FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id
      JOIN agents_platform.accounts a ON ((t.principal->>'kind'='human' AND a.issuer=t.principal->>'issuer' AND a.subject=t.principal->>'subject') OR (t.principal->>'kind'='automation' AND a.id::text=t.principal->>'ownerAccountId'))
      JOIN agents_platform.conversations c ON c.id=t.conversation_id
      JOIN agents_platform.memberships m ON m.organization_id=t.organization_id AND m.account_id=a.id AND m.revoked_at IS NULL
      WHERE t.id=$1 AND t.principal->>'kind' IN ('human','automation')`, [taskId])).rows[0];
    if (!task || task.source_deleted) throw missing();
    if(task.principal.kind==="automation")await resolveAutomationOwner(db,task.organization_id,task.principal);
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
      const initial=await loadExecution(db,taskId);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
      const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
      if(this.evidence)await assertCurrentEvidence(db,taskId,await taskEvidenceManifest(db,taskId));
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.write")) throw new PlatformError("ARTIFACT_SCOPE_DENIED",403,"Artifact access is unavailable");
      if(!(await db.query("SELECT id FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND name IN ('sandbox.analyze','skills.run','report.prepare') AND state IN ('started','completed')",[operationId,taskId])).rowCount) throw missing();
      return this.owner(db,taskId);
    });
    const snapshot=(await this.pool.query("SELECT source_references,memory_scope_id,memory_generation,payload FROM agents_platform.context_snapshots WHERE task_id=$1 ORDER BY step DESC LIMIT 1",[taskId])).rows[0];
    const sourceReferences=[...(input.sourceReferences??[]) .filter((reference:any)=>reference?.kind==="artifact"||reference?.kind==="memory_scope"),
      ...(snapshot?.memory_scope_id?[{kind:"memory_scope",id:snapshot.memory_scope_id,generation:Number(snapshot.memory_generation),expiresAt:snapshot.payload.memoryExpiresAt}]:[])];
    const key=createHash("sha256").update(canonicalJson([taskId,operationId,meta])).digest("hex");
    const artifact=await this.artifacts.put(owner.scope,{operationId:`task:${key}`,contentType:meta.contentType,content:input.content},{
      taskId,rootTaskId:owner.task.root_task_id,name:meta.name,sourceReferences,
      validate:async(db,id)=>{
        const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);await this.owner(db,taskId);
        if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
        const existing=(await db.query("SELECT id FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='artifact' AND owner_id=$2",[taskId,id])).rows[0];
        if(existing)await this.assertEvidence(db,taskId,id);
        else{const script=(await db.query("SELECT * FROM agents_platform.skill_script_executions WHERE operation_id=$1 AND task_id=$2",[operationId,taskId])).rows[0];
          const node=await this.evidence.deriveWithin(db,taskId,"artifact",id,script?[{kind:"skill",skillId:script.skill_revision_id,agentId:script.agent_id,packageDigest:script.package_digest}]:[]);
          await db.query("UPDATE agents_platform.artifacts SET source_references=$2 WHERE id=$1",[id,JSON.stringify([...sourceReferences,{kind:"evidence",id:node.id,digest:node.manifest.digest}])]);}
      }
    });
    return dto((await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1",[artifact.id])).rows[0]);
  }

  async prepareReport(taskId:string,name:string,generatedOutput:string):Promise<{id:string}> {
    const matches=(await this.listForRoot(taskId)).filter(a=>a.name===name);
    if(matches.length>1)throw new PlatformError("REPORT_ARTIFACT_AMBIGUOUS",409,"Choose a unique report name");
    if(matches.length===1){const report=await this.readForTask(taskId,matches[0]!.id);await this.validateReport(taskId,report.artifact.id,new TextDecoder("utf-8",{fatal:true}).decode(report.content));return {id:matches[0]!.id};}
    if((await loadExecution(this.pool,taskId)).configuration.capabilities.sandbox.enabled)throw new PlatformError("REPORT_ARTIFACT_MISSING",409,"The configured report was not produced");
    if(!generatedOutput.trim())throw new PlatformError("REPORT_EMPTY",409,"The report is empty");
    const operation=(await this.pool.query("SELECT id FROM agents_platform.operations WHERE task_id=$1 AND name='report.prepare' AND state='started' ORDER BY started_at DESC LIMIT 1",[taskId])).rows[0];
    if(!operation)throw missing();
    const artifact=await this.put(taskId,operation.id,{name,contentType:"text/markdown",content:Buffer.from(generatedOutput)});
    await this.validateReport(taskId,artifact.id,generatedOutput);return {id:artifact.id};
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
    const result=await this.read(actor.task,artifactId);
    if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    await transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[actor.task.organization_id]);
      await this.evidence!.inheritArtifactWithin(db,taskId,artifactId);
    });return result;
  }
  private async read(task:Record<string,any>,artifactId:string):Promise<{artifact:TaskArtifact;content:Uint8Array}> {
    const row=(await this.pool.query(`SELECT a.* FROM agents_platform.artifacts a WHERE a.id=$1 AND a.root_task_id=$2 AND a.state='available'
      AND (a.task_id=$3 OR $3=$2 OR EXISTS(SELECT 1 FROM agents_platform.task_artifact_transfers x WHERE x.artifact_id=a.id AND x.target_task_id=$3))`,
    [artifactId,task.root_task_id,task.id])).rows[0];
    if(!row)throw missing();const producer=await this.owner(this.pool,row.task_id);
    await this.validateSources(row);
    const result=await this.artifacts.get(producer.scope,artifactId,true);
    await this.owner(this.pool,task.id);await this.owner(this.pool,row.task_id);await this.validateSources(row);
    return {artifact:dto(row),content:result.content};
  }
  private async validateSources(artifact:Record<string,any>):Promise<void> {
    const visited=new Set<string>();let references=0;
    const visit=async (row:Record<string,any>,depth:number):Promise<void>=>{
      if(depth>32||++references>128)throw missing();
      if(visited.has(row.id))return;visited.add(row.id);
      if(row.state!=="available"||row.root_task_id!==artifact.root_task_id)throw missing();
      await this.owner(this.pool,row.task_id);
      await this.assertEvidence(this.pool,row.task_id,row.id);
      for(const reference of row.source_references as {kind?:string;id?:string;generation?:number;expiresAt?:number}[]) {
        if(++references>128)throw missing();
        if(reference.kind==="memory_scope") {
          const fence=(await this.pool.query("SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1",[reference.id])).rows[0];
          if(!fence||Number(fence.generation)!==reference.generation||fence.next_expiry_at&&new Date(fence.next_expiry_at).getTime()<=Date.now()||reference.expiresAt!==undefined&&Date.now()>=reference.expiresAt)throw missing();
        } else if(reference.kind==="artifact") {
          const source=(await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 AND root_task_id=$2",[reference.id,artifact.root_task_id])).rows[0];
          if(!source)throw missing();await visit(source,depth+1);
        }
      }
    };
    await visit(artifact,0);
  }
  async download(accountId:string,organizationId:string,taskId:string,artifactId:string) {
    const actor=await this.owner(this.pool,taskId);
    if(actor.scope.organizationId!==organizationId)throw missing();
    if(actor.scope.accountId!==accountId) {
      if(actor.task.principal.kind!=="automation"||await resolveAutomationReviewer(this.pool,organizationId,actor.task.root_task_id)!==accountId)throw missing();
      if(!(await this.pool.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL",[organizationId,accountId])).rowCount)throw missing();
      if(!(await this.pool.query("SELECT 1 FROM agents_platform.actions WHERE root_task_id=$1 AND artifact_id=$2 AND reviewer_account_id=$3",[actor.task.root_task_id,artifactId,accountId])).rowCount)throw missing();
    }
    return this.read(actor.task,z.uuid().parse(artifactId));
  }
  async transfer(parentTaskId:string,targetTaskId:string,artifactId:string):Promise<void> {
    await this.readForTask(parentTaskId,artifactId);
    await transaction(this.pool,async db=>{
      const parent=await loadExecution(db,parentTaskId,true);await assertCurrentAuthority(db,parent);
      const child=await this.owner(db,targetTaskId);
      if(child.task.parent_task_id!==parentTaskId||child.task.root_task_id!==(parent.task as any).root_task_id)throw missing();
      if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
      await this.evidence.inheritArtifactWithin(db,targetTaskId,artifactId);
      await db.query(`INSERT INTO agents_platform.task_artifact_transfers(artifact_id,target_task_id,granted_by_task_id)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[artifactId,targetTaskId,parentTaskId]);
    });
  }
}
