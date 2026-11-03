import { createHash } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { canonicalJson,PlatformError } from "../../contracts/contracts";
import { createDependencyManifest, type DependencyManifest, type EvidenceDependency } from "../../contracts/source-contracts";
import { transaction } from "../../infrastructure/database";
import { type PrivateObjectStore } from "../../infrastructure/object-store";
import { productPorts } from "../../infrastructure/product-ports";
import { assertCurrentEvidence,EvidenceStore,taskEvidenceManifest } from "../context/evidence";
import { inspectionAuthority } from "../context/evidence-policy";
import { currentProductInformation } from "../products/product-information";
import { delegationAncestors } from "../delegation/scope";
import { resolveAutomationOwner,resolveAutomationReviewer } from "../lifecycle/automation-authority";
import { assertCurrentAuthority,loadExecution } from "../lifecycle/execution";
import { ArtifactStore, type ArtifactOwner } from "./artifacts";

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
    return (this.evidence??new EvidenceStore(this.pool)).artifactManifest(db,taskId,artifactId);
  }
  async validateReport(taskId:string,artifactId:string,content:string){
    if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    await this.assertEvidence(this.pool,taskId,artifactId);return this.evidence.validateReport(taskId,artifactId,content);
  }
  private async owner(db: Pool | PoolClient, taskId: string): Promise<{ task: Record<string, any>; scope: ArtifactOwner }> {
    const task = (await db.query(`SELECT t.*,v.agent_id,a.id AS account_id,c.deleted_at AS source_deleted
      FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id
      LEFT JOIN agents_platform.accounts a ON t.product='agents' AND ((t.principal->>'kind'='human' AND a.issuer=t.principal->>'issuer' AND a.subject=t.principal->>'subject') OR (t.principal->>'kind'='automation' AND a.id::text=t.principal->>'ownerAccountId'))
      JOIN agents_platform.conversations c ON c.id=t.conversation_id
      LEFT JOIN agents_platform.memberships m ON m.organization_id=t.organization_id AND m.account_id=a.id AND m.revoked_at IS NULL
      WHERE t.id=$1 AND t.principal->>'kind' IN ('human','automation')`, [taskId])).rows[0];
    if (!task || task.source_deleted) throw missing();
    if(task.product!=="agents"){
      if(!["growth","agencies"].includes(task.product)||task.principal.kind!=="human")throw missing();
      const execution=await loadExecution(db,taskId);await inspectionAuthority(db,execution);
      const ports=productPorts(db);
      if(!ports.assertCurrentOrigin)throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE",503,"Product artifact authorization is unavailable");
      await ports.assertCurrentOrigin(db,taskId);
      return {task,scope:{namespace:"product_task",product:task.product,organizationId:task.organization_id,agentId:task.agent_id,taskId}};
    }
    if(!task.account_id||!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL",[task.organization_id,task.account_id])).rowCount)throw missing();
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
      const operation=(await db.query("SELECT name FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND name IN ('sandbox.analyze','skills.run','report.prepare','artifact.create') AND state IN ('started','completed')",[operationId,taskId])).rows[0];
      if(!operation)throw missing();
      return {...await this.owner(db,taskId),operationName:operation.name as string};
    });
    const snapshot=(await this.pool.query("SELECT source_references,memory_scope_id,memory_generation,payload FROM agents_platform.context_snapshots WHERE task_id=$1 ORDER BY step DESC LIMIT 1",[taskId])).rows[0];
    const sourceReferences=[...(input.sourceReferences??[]) .filter((reference:any)=>reference?.kind==="artifact"||reference?.kind==="memory_scope"),
      ...(snapshot?.memory_scope_id?[{kind:"memory_scope",id:snapshot.memory_scope_id,generation:Number(snapshot.memory_generation),expiresAt:snapshot.payload.memoryExpiresAt}]:[])];
    const multipleExports=owner.operationName==="sandbox.analyze"||owner.operationName==="skills.run";
    const identity="namespace" in owner.scope?(multipleExports?[taskId,operationId,meta.name]:[taskId,operationId]):[taskId,operationId,meta];
    const key=createHash("sha256").update(canonicalJson(identity)).digest("hex");
    const artifact=await this.artifacts.put(owner.scope,{operationId:`task:${key}`,contentType:meta.contentType,content:input.content},{
      taskId,rootTaskId:owner.task.root_task_id,name:meta.name,sourceReferences,
      validate:async(db,id,phase)=>{
        const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);await this.owner(db,taskId);
        if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
        if("namespace" in owner.scope&&phase==="prepare"){
          await assertCurrentEvidence(db,taskId,await taskEvidenceManifest(db,taskId));return;
        }
        const existing=(await db.query("SELECT id FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='artifact' AND owner_id=$2",[taskId,id])).rows[0];
        if(existing)await this.assertEvidence(db,taskId,id);
        else{const script=(await db.query("SELECT * FROM agents_platform.skill_script_executions WHERE operation_id=$1 AND task_id=$2",[operationId,taskId])).rows[0];
          const dependencies:EvidenceDependency[]=script?[{kind:"skill",skillId:script.skill_revision_id,agentId:script.agent_id,packageDigest:script.package_digest}]:[];
          if("namespace" in owner.scope){const information=await currentProductInformation(db,execution);
            dependencies.push({kind:"product_artifact",version:"1",product:owner.scope.product,tenantId:information.origin.tenantId,taskId,artifactId:id,
              contentDigest:createHash("sha256").update(input.content).digest("hex"),name:meta.name,contentType:meta.contentType,bytes:input.content.byteLength,information});}
          const node=await this.evidence.deriveWithin(db,taskId,"artifact",id,dependencies);
          await db.query("UPDATE agents_platform.artifacts SET source_references=$2 WHERE id=$1",[id,JSON.stringify([...sourceReferences,{kind:"evidence",id:node.id,digest:node.manifest.digest}])]);}
        await this.evidence.recordArtifactCitationsWithin(db,taskId,id,input.content);
      }
    });
    return dto((await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1",[artifact.id])).rows[0]);
  }

  async prepareReport(taskId:string,name:string,generatedOutput:string):Promise<{id:string}> {
    const actor=await this.owner(this.pool,taskId);
    const matches=(await this.pool.query(`SELECT a.id FROM agents_platform.artifacts a JOIN agents_platform.tasks t ON t.id=a.task_id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE a.root_task_id=$1 AND a.organization_id=$2
      AND a.name=$3 AND a.state='available' AND c.deleted_at IS NULL
      AND (a.task_id=$4 OR $4::uuid=$1 OR EXISTS(SELECT 1 FROM agents_platform.task_artifact_transfers x WHERE x.artifact_id=a.id AND x.target_task_id=$4))
      ORDER BY a.created_at,a.id LIMIT 2`,[actor.task.root_task_id,actor.scope.organizationId,name,taskId])).rows;
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
    const actor=await this.owner(this.pool,rootTaskId);
    if("namespace" in actor.scope){
      const grant=(await this.pool.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[actor.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.read"))return [];
    }
    const rows=(await this.pool.query(`SELECT a.* FROM agents_platform.artifacts a JOIN agents_platform.tasks t ON t.id=a.task_id
      JOIN agents_platform.conversations c ON c.id=t.conversation_id WHERE a.root_task_id=$1 AND a.state='available'
      AND c.deleted_at IS NULL ORDER BY a.created_at,a.id LIMIT 100`,[rootTaskId])).rows;
    const visible:TaskArtifact[]=[];
    for(const row of rows)try{await this.recordForTask(actor.task,row.id);visible.push(dto(row));}
    catch(error){if(!(error instanceof PlatformError)||![403,404,409].includes(error.statusCode))throw error;}
    await this.owner(this.pool,rootTaskId);return visible;
  }
  private async selectedChild(rootTaskId:string,childTaskId:string){
    z.uuid().parse(rootTaskId);z.uuid().parse(childTaskId);
    const root=await this.owner(this.pool,rootTaskId),child=await this.owner(this.pool,childTaskId);
    if(!("namespace" in root.scope)||!("namespace" in child.scope)||root.task.parent_task_id||
      child.task.root_task_id!==rootTaskId||child.task.product!==root.task.product||child.task.organization_id!==root.task.organization_id||
      canonicalJson(child.task.principal)!==canonicalJson(root.task.principal))throw missing();
    const childExecution=await loadExecution(this.pool,childTaskId);
    if(!(await delegationAncestors(this.pool,childExecution)).some(ancestor=>ancestor.task.id===rootTaskId))throw missing();
    await assertCurrentEvidence(this.pool,rootTaskId,await taskEvidenceManifest(this.pool,rootTaskId),{requireActiveTask:false});
    await assertCurrentEvidence(this.pool,childTaskId,await taskEvidenceManifest(this.pool,childTaskId),{requireActiveTask:false});
    const grants=(await this.pool.query("SELECT id,operations FROM agents_platform.execution_grants WHERE id=ANY($1::uuid[])",[[root.task.grant_id,child.task.grant_id]])).rows;
    const permitted=grants.find(row=>row.id===root.task.grant_id)?.operations.includes("artifact.read")&&grants.find(row=>row.id===child.task.grant_id)?.operations.includes("artifact.read");
    return {root,child,permitted:Boolean(permitted)};
  }
  async listForChild(rootTaskId:string,childTaskId:string):Promise<TaskArtifact[]>{
    const selected=await this.selectedChild(rootTaskId,childTaskId);if(!selected.permitted)return [];
    const rows=(await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE task_id=$1 AND root_task_id=$2 AND state='available' ORDER BY created_at,id LIMIT 100",[childTaskId,rootTaskId])).rows;
    const visible:TaskArtifact[]=[];
    for(const row of rows)try{await this.recordForTask(selected.child.task,row.id);visible.push(dto(row));}
    catch(error){if(!(error instanceof PlatformError)||![403,404,409].includes(error.statusCode))throw error;}
    await this.selectedChild(rootTaskId,childTaskId);return visible;
  }
  /** Product UI access is scoped by the authenticated product command before this call. */
  async readForProduct(taskId:string,artifactId:string,childTaskId?:string):Promise<{artifact:TaskArtifact;content:Uint8Array}>{
    z.uuid().parse(artifactId);const actor=await this.owner(this.pool,taskId);
    if(!("namespace" in actor.scope)||actor.task.parent_task_id)throw missing();
    const grant=(await this.pool.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[actor.task.grant_id])).rows[0];
    if(!grant?.operations.includes("artifact.read"))throw missing();
    if(childTaskId){
      const selected=await this.selectedChild(taskId,childTaskId);if(!selected.permitted)throw missing();
      if(!(await this.pool.query("SELECT 1 FROM agents_platform.artifacts WHERE id=$1 AND task_id=$2 AND root_task_id=$3 AND state='available'",[artifactId,childTaskId,taskId])).rowCount)throw missing();
      const result=await this.read(selected.child.task,artifactId);
      if(result.artifact.taskId!==childTaskId)throw missing();
      const current=await this.selectedChild(taskId,childTaskId);if(!current.permitted)throw missing();
      return result;
    }
    return this.read(actor.task,artifactId);
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
  async inspectForTask(taskId:string,artifactId:string):Promise<TaskArtifact> {
    z.uuid().parse(artifactId);
    const actor=await transaction(this.pool,async db=>{
      const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.read"))throw missing();return this.owner(db,taskId);
    });
    return dto(await this.recordForTask(actor.task,artifactId));
  }
  /** Inspect a recoverable handle without reading bytes or installing its recovery link. */
  async inspectHistoryArtifact(taskId:string,originTaskId:string,artifactId:string):Promise<{artifact:TaskArtifact;manifest:DependencyManifest}> {
    z.uuid().parse(originTaskId);z.uuid().parse(artifactId);
    if(taskId===originTaskId){
      await this.inspectForTask(taskId,artifactId);
      const row=(await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1",[artifactId])).rows[0];
      if(!row)throw missing();const manifest=await this.validateSources(row);
      await assertCurrentEvidence(this.pool,taskId,manifest);return{artifact:dto(row),manifest};
    }
    const actor=await transaction(this.pool,async db=>{
      const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.read"))throw missing();return this.owner(db,taskId);
    });
    const origin=await this.owner(this.pool,originTaskId);
    if(origin.task.product!==actor.task.product||origin.task.agent_id!==actor.task.agent_id||
      origin.task.resource_id!==actor.task.resource_id||origin.task.caller_client_id!==actor.task.caller_client_id||
      origin.task.conversation_id!==actor.task.conversation_id||canonicalJson(origin.task.principal)!==canonicalJson(actor.task.principal))throw missing();
    const row=await this.recordForTask(origin.task,artifactId),manifest=await this.validateSources(row);
    await (this.evidence??new EvidenceStore(this.pool)).checkRetainedArtifactHistory(taskId,originTaskId,artifactId,manifest);
    return{artifact:dto(row),manifest};
  }
  async readRetainedForTask(taskId:string,originTaskId:string,artifactId:string):Promise<{artifact:TaskArtifact;content:Uint8Array}> {
    z.uuid().parse(originTaskId);z.uuid().parse(artifactId);
    if(originTaskId===taskId)return this.readForTask(taskId,artifactId);
    const actor=await transaction(this.pool,async db=>{
      const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.read"))throw missing();return this.owner(db,taskId);
    });
    const origin=await this.owner(this.pool,originTaskId);
    if(origin.task.product!==actor.task.product||origin.task.agent_id!==actor.task.agent_id||
      origin.task.resource_id!==actor.task.resource_id||origin.task.caller_client_id!==actor.task.caller_client_id||
      origin.task.conversation_id!==actor.task.conversation_id||canonicalJson(origin.task.principal)!==canonicalJson(actor.task.principal))throw missing();
    const evidence=this.evidence??new EvidenceStore(this.pool);
    await evidence.checkRetainedArtifactHistory(taskId,originTaskId,artifactId);
    const result=await this.read(origin.task,artifactId);
    const row=(await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1",[artifactId])).rows[0];
    if(!row)throw missing();const manifest=await this.validateSources(row);
    await transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[actor.task.organization_id]);
      await this.owner(db,taskId);
      await evidence.recordArtifactCitationsWithin(db,row.task_id,artifactId,result.content);
      await evidence.inheritRetainedArtifactWithin(db,taskId,originTaskId,artifactId,manifest);
    });
    await this.recordForTask(actor.task,artifactId);return result;
  }
  private async retainedLink(taskId:string,artifactId:string,db:Pool|PoolClient=this.pool,originTaskId?:string):Promise<boolean> {
    return Boolean((await db.query(`SELECT 1 FROM agents_platform.evidence_nodes n
      JOIN agents_platform.evidence_history_links h ON h.node_id=n.id
      JOIN agents_platform.evidence_nodes original ON original.id=ANY(h.origin_node_ids)
      JOIN agents_platform.artifacts a ON a.id=$2 AND a.task_id=original.task_id AND a.root_task_id=original.root_task_id
      WHERE n.task_id=$1 AND n.kind='input' AND n.owner_id='retained-artifact:'||$2::text
        AND original.kind='artifact' AND original.owner_id=$2::text AND a.state='available'
        AND ($3::uuid IS NULL OR h.origin_task_id=$3)`,[taskId,artifactId,originTaskId??null])).rowCount);
  }
  private async transferredLink(taskId:string,artifactId:string,db:Pool|PoolClient=this.pool):Promise<boolean> {
    return Boolean((await db.query(`SELECT 1 FROM agents_platform.task_artifact_transfers x
      JOIN agents_platform.tasks t ON t.id=x.target_task_id AND t.parent_task_id=x.granted_by_task_id
      JOIN agents_platform.evidence_nodes n ON n.task_id=t.id AND n.root_task_id=t.root_task_id
        AND n.kind='input' AND n.owner_id='artifact:'||x.artifact_id::text
      WHERE x.target_task_id=$1 AND x.artifact_id=$2`,[taskId,artifactId])).rowCount);
  }
  private async recordForTask(task:Record<string,any>,artifactId:string):Promise<Record<string,any>> {
    const row=(await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 AND organization_id=$2 AND state='available'",[artifactId,task.organization_id])).rows[0];
    if(row?.root_task_id===task.root_task_id){
      if(row.task_id!==task.id&&task.id!==task.root_task_id&&!(await this.pool.query("SELECT 1 FROM agents_platform.task_artifact_transfers WHERE artifact_id=$1 AND target_task_id=$2",[artifactId,task.id])).rowCount&&!await this.retainedLink(task.id,artifactId))throw missing();
    }else{
      if(!row||!await this.retainedLink(task.id,artifactId)&&!await this.transferredLink(task.id,artifactId))throw missing();
      await assertCurrentEvidence(this.pool,task.id,await taskEvidenceManifest(this.pool,task.id),{requireActiveTask:false});
    }
    if(!row)throw missing();await this.owner(this.pool,row.task_id);
    const manifest=await this.validateSources(row);
    if(row.product_owner&&row.root_task_id===task.root_task_id)await assertCurrentEvidence(this.pool,task.id,manifest,{requireActiveTask:false});
    await this.owner(this.pool,task.id);return row;
  }
  private async read(task:Record<string,any>,artifactId:string):Promise<{artifact:TaskArtifact;content:Uint8Array}> {
    const row=await this.recordForTask(task,artifactId),producer=await this.owner(this.pool,row.task_id);
    const result="namespace" in producer.scope?await this.artifacts.getProduct(producer.scope,artifactId):await this.artifacts.get(producer.scope,artifactId,true);
    const current=await this.recordForTask(task,artifactId);
    if(current.content_digest!==row.content_digest||current.object_key!==row.object_key)throw new PlatformError("ARTIFACT_INTEGRITY",502,"Content integrity check failed");
    return {artifact:dto(row),content:result.content};
  }
  private async validateSources(artifact:Record<string,any>):Promise<DependencyManifest> {
    const visited=new Set<string>(),active=new Set<string>(),dependencies:EvidenceDependency[]=[];
    const pending:{row:Record<string,any>;exit:boolean}[]=[{row:artifact,exit:false}];
    while(pending.length){
      const {row,exit}=pending.pop()!;
      if(exit){active.delete(row.id);visited.add(row.id);continue;}
      if(active.has(row.id))throw missing();
      if(visited.has(row.id))continue;
      active.add(row.id);pending.push({row,exit:true});
      if(row.state!=="available"||row.organization_id!==artifact.organization_id)throw missing();
      await this.owner(this.pool,row.task_id);
      const manifest=await this.assertEvidence(this.pool,row.task_id,row.id);
      if(row.product_owner&&!manifest.dependencies.some(dependency=>dependency.kind==="product_artifact"&&dependency.product===row.product_owner&&
        dependency.taskId===row.task_id&&dependency.artifactId===row.id&&dependency.contentDigest===row.content_digest))throw missing();
      dependencies.push(...manifest.dependencies);
      for(const reference of row.source_references as {kind?:string;id?:string;generation?:number;expiresAt?:number}[]) {
        if(reference.kind==="memory_scope") {
          const fence=(await this.pool.query("SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1",[reference.id])).rows[0];
          if(!fence||Number(fence.generation)!==reference.generation||fence.next_expiry_at&&new Date(fence.next_expiry_at).getTime()<=Date.now()||reference.expiresAt!==undefined&&Date.now()>=reference.expiresAt)throw missing();
          dependencies.push({kind:"memory",referenceId:reference.id!,generation:reference.generation!});
        } else if(reference.kind==="artifact") {
          const source=(await this.pool.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 AND organization_id=$2",[reference.id,artifact.organization_id])).rows[0];
          if(!source||source.root_task_id!==row.root_task_id&&!await this.retainedLink(row.task_id,source.id)&&!await this.transferredLink(row.task_id,source.id))throw missing();pending.push({row:source,exit:false});
        }
      }
    }
    return createDependencyManifest(dependencies);
  }
  async download(accountId:string,organizationId:string,taskId:string,artifactId:string) {
    const actor=await this.owner(this.pool,taskId);
    if("namespace" in actor.scope)throw missing();
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
      const parent=await loadExecution(db,parentTaskId);
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[parent.task.organization_id]);
      await this.transferWithin(db,parentTaskId,targetTaskId,artifactId);
    });
  }

  /** Admit an exact authorized transfer before the child becomes visible to the dispatcher. */
  async transferWithin(db:PoolClient,parentTaskId:string,targetTaskId:string,artifactId:string,contentDigest?:string,originTaskId?:string):Promise<void> {
    z.uuid().parse(artifactId);
    const parent=await loadExecution(db,parentTaskId,true);await assertCurrentAuthority(db,parent);
    const child=await this.owner(db,targetTaskId);
    if(child.task.parent_task_id!==parentTaskId||child.task.root_task_id!==parent.task.root_task_id)throw missing();
    const grants=(await db.query("SELECT id,operations FROM agents_platform.execution_grants WHERE id=ANY($1::uuid[])",[[parent.task.grant_id,child.task.grant_id]])).rows;
    if(!grants.find(row=>row.id===parent.task.grant_id)?.operations.includes("artifact.read")||
      !grants.find(row=>row.id===child.task.grant_id)?.operations.includes("artifact.read"))throw missing();
    const row=(await db.query(`SELECT a.id,a.task_id,a.root_task_id,a.content_digest FROM agents_platform.artifacts a
      WHERE a.id=$1 AND a.organization_id=$2 AND a.state='available' FOR SHARE OF a`,[artifactId,parent.task.organization_id])).rows[0];
    if(!row||contentDigest!==undefined&&row.content_digest!==contentDigest)throw missing();
    if(row.root_task_id===parent.task.root_task_id){
      if(row.task_id!==parentTaskId&&parentTaskId!==parent.task.root_task_id&&
        !(await db.query("SELECT 1 FROM agents_platform.task_artifact_transfers WHERE artifact_id=$1 AND target_task_id=$2",[artifactId,parentTaskId])).rowCount&&
        !await this.retainedLink(parentTaskId,artifactId,db,originTaskId))throw missing();
    }else if(!originTaskId||!await this.retainedLink(parentTaskId,artifactId,db,originTaskId)&&
      !(originTaskId===parentTaskId&&(await this.retainedLink(parentTaskId,artifactId,db)||await this.transferredLink(parentTaskId,artifactId,db))))throw missing();
    if(!this.evidence)throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private storage is unavailable");
    await db.query(`INSERT INTO agents_platform.task_artifact_transfers(artifact_id,target_task_id,granted_by_task_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[artifactId,targetTaskId,parentTaskId]);
    await this.evidence.inheritArtifactWithin(db,targetTaskId,artifactId);
  }
}
