import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { type ResourceHandle } from "../../contracts/capability-catalog";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import {
assertDependencyManifest,collectDependencyGraph,createDependencyManifest,dependencyFrontier,evidenceDependencySchema,
SOURCE_LIMITS,textDigest,
type DependencyManifest,type EvidenceDependency
} from "../../contracts/source-contracts";
import { transaction } from "../../infrastructure/database";
import { PrivateObjectStore } from "../../infrastructure/object-store";
import { writeExecutionObject } from "../artifacts/execution-objects";
import { assertCurrentAuthority,loadExecution,type Execution } from "../lifecycle/execution";
import { historyPrincipalAllowed } from "./visitor-lineage";
import { continuationChildAllowed } from "./work-lineage";
import { memoryScopeMatchesExecution } from "../memory/scope";
import { fitUtf8 } from "../../infrastructure/utf8";
import { selectedProductContextText } from "../products/product-information";
import { requiresProductAccess } from "../../capabilities/products/product-capabilities";

import { assertCurrentEvidence,bindingAllowed,boundedText,childHistoryAllowed,citationLabels,ConnectedEvidenceInput,Db,delegationDependency,denied,dto,EvidenceKind,EvidenceNode,EvidencePassage,inspectionAuthority,integrity,memoryVisible,nodeDto,owner,payloadHas,ProductEvidenceInput,suppliedNodes,taskEvidenceManifest,unavailable } from "./evidence-policy";
export { assertChildConnectedAuthority,assertCurrentAuthority,assertCurrentEvidence,assertDelegationInputEvidence,bindingAllowed,boundedText,citationLabels,ConnectedEvidenceInput,connectionEvidenceBinding,Db,delegationDependency,delegationInput,denied,dto,EvidenceKind,EvidenceNode,EvidencePassage,historyOrigins,inspectionAuthority,integrity,memoryVisible,nodeDto,owner,payloadHas,rootRoleAllows,sourceAllowed,suppliedNodes,taskEvidenceManifest,unavailable } from "./evidence-policy";
export type { ProductEvidenceInput } from "./evidence-policy";

function evidenceGraphIds(rootIds:readonly string[],graph:ReadonlyMap<string,EvidenceNode>,seen=new Set<string>()):Set<string>{
  const ids=new Set<string>(),pending=[...rootIds];
  while(pending.length){const id=pending.pop()!;if(seen.has(id))continue;seen.add(id);
    const node=graph.get(id);if(!node)throw integrity();
    for(const reference of node.evidenceIds)ids.add(reference);
    for(const parent of node.parents)pending.push(parent);
  }
  return ids;
}

export class EvidenceStore {
  constructor(private readonly pool: Pool, private readonly objects?: PrivateObjectStore) {}
  private objectStore(): PrivateObjectStore {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE",503,"Private evidence storage is unavailable");
    return this.objects;
  }
  private async scoped<T>(taskId: string, work: (db: PoolClient, execution: Execution) => Promise<T>, options: {allowSettled?:boolean} = {}): Promise<T> {
    return transaction(this.pool, async db => {
      const initial = await loadExecution(db, taskId);
      // Serialize evidence mutations per organization without holding the organization row lock.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [initial.task.organization_id]);
      const execution = await loadExecution(db, taskId);
      await assertCurrentAuthority(db, execution, options);
      return work(db, execution);
    });
  }
  private async operation(db: Db, taskId: string, operationId: string, names?: string[]): Promise<void> {
    const row = (await db.query("SELECT * FROM agents_platform.operations WHERE id=$1 AND task_id=$2", [operationId, taskId])).rows[0];
    if (!row || !["started", "completed"].includes(row.state) || names && !names.includes(row.name)) throw denied();
  }
  private async currentParents(db:Db,execution:Execution,exclude?:{kind:EvidenceKind;ownerId:string}):Promise<EvidenceNode[]>{
    const nodes=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1 ORDER BY created_at,id",[execution.task.root_task_id])).rows.map(nodeDto);
    return dependencyFrontier(nodes.filter(node=>node.taskId===execution.task.id&&(!exclude||node.kind!==exclude.kind||node.ownerId!==exclude.ownerId)),new Map(nodes.map(node=>[node.id,node])));
  }
  private async insert(db: PoolClient, execution: Execution, operationId: string, input: {
    sourceId?: string; revisionId?: string; chunkId?: string; start: number; end: number; text: string; title: string;
    acquiredAt: string; manifest: DependencyManifest; page?: number | null; section?: string | null;
    bindingId?: string; resource?: ResourceHandle; receiptDigest?: string; objectKey?: string; inlineContent?: string;
  }): Promise<EvidencePassage> {
    boundedText(input.text);
    const digest = requestDigest(input);
    const prior = (await db.query("SELECT * FROM agents_platform.evidence_references WHERE task_id=$1 AND operation_id=$2 AND request_digest=$3", [execution.task.id, operationId, digest])).rows[0];
    await assertCurrentEvidence(db, execution.task.id, input.manifest);
    if (prior) return { reference: dto(prior), label: prior.citation_label, text: input.text, title: input.title, page: input.page ?? null, section: input.section ?? null };
    const count = Number((await db.query("SELECT count(*) AS count FROM agents_platform.evidence_references WHERE task_id=$1 AND operation_id=$2", [execution.task.id,operationId])).rows[0].count);
    if (count >= SOURCE_LIMITS.manifestNodes) throw new PlatformError("EVIDENCE_LIMIT", 413, "Too many evidence references");
    const id = randomUUID(), label = `E${id.replaceAll("-", "")}`;
    const row = (await db.query(`INSERT INTO agents_platform.evidence_references
      (id,organization_id,root_task_id,task_id,operation_id,citation_label,request_digest,source_id,revision_id,chunk_id,start_offset,end_offset,content_digest,acquired_at,manifest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [id, execution.task.organization_id, execution.task.root_task_id, execution.task.id, operationId, label, digest, input.sourceId ?? null, input.revisionId ?? null, input.chunkId ?? null, input.start, input.end, textDigest(input.text), input.acquiredAt, input.manifest])).rows[0];
    await db.query(`INSERT INTO agents_platform.evidence_contents(reference_id,object_key,title,content_bytes,page,section,binding_id,resource,receipt_digest,inline_content)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, input.objectKey ?? null, input.title.slice(0,200), Buffer.byteLength(input.text), input.page ?? null, input.section ?? null, input.bindingId ?? null, input.resource ?? null, input.receiptDigest ?? null, input.inlineContent ?? null]);
    return { reference: dto(row), label, text: input.text, title: input.title.slice(0,200), page: input.page ?? null, section: input.section ?? null };
  }
  async recordChunk(taskId: string, operationId: string, chunkId: string, span: {start?: number; end?: number} = {}): Promise<EvidencePassage> {
    return this.scoped(taskId, async (db, execution) => {
      await this.operation(db, taskId, operationId, ["knowledge.search", "knowledge.read"]);
      const row = (await db.query(`SELECT c.*,r.source_id,r.acquired_at,s.title,s.generation FROM agents_platform.source_chunks c
        JOIN agents_platform.source_revisions r ON r.id=c.revision_id JOIN agents_platform.sources s ON s.id=r.source_id
        WHERE c.id=$1 AND c.organization_id=$2`, [chunkId, execution.task.organization_id])).rows[0];
      if (!row || textDigest(row.content) !== row.content_digest) throw integrity();
      const start = span.start ?? row.start_offset, end = span.end ?? row.end_offset;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < row.start_offset || end > row.end_offset || end <= start) throw integrity();
      const splitSurrogate = (offset:number) => offset > 0 && offset < row.content.length && /[\uD800-\uDBFF]/.test(row.content[offset-1]) && /[\uDC00-\uDFFF]/.test(row.content[offset]);
      if(splitSurrogate(start-row.start_offset)||splitSurrogate(end-row.start_offset))throw integrity();
      const text = row.content.slice(start-row.start_offset, end-row.start_offset);
      return this.insert(db, execution, operationId, {sourceId:row.source_id,revisionId:row.revision_id,chunkId,start,end,text,title:row.title,
        acquiredAt:new Date(row.acquired_at).toISOString(),page:row.page,section:row.section,
        manifest:createDependencyManifest([{kind:"source",sourceId:row.source_id,revisionId:row.revision_id,generation:row.generation}])});
    });
  }
  async recordConnected(taskId: string, operationId: string, input: ConnectedEvidenceInput): Promise<EvidencePassage> {
    boundedText(input.text); z.string().regex(/^[a-f0-9]{64}$/).parse(input.receiptDigest); z.string().datetime().parse(input.acquiredAt);
    const initial = await loadExecution(this.pool, taskId);
    const objectKey = `evidence/${initial.task.organization_id}/${initial.task.root_task_id}/${textDigest(input.text)}`;
    // Content-addressed bytes are immutable; policy is checked again before the reference is published.
    await writeExecutionObject(this.pool,this.objectStore(),{taskId,operationId,key:objectKey,bytes:Buffer.from(input.text),contentType:"text/plain; charset=utf-8"});
    return this.scoped(taskId, async (db, execution) => {
      const binding = await bindingAllowed(db, execution, input.bindingId, operationId);
      await this.operation(db, taskId, operationId, [binding.alias]);
      if (!binding.resources.some(resource => requestDigest(resource) === requestDigest(input.resource))) throw denied();
      return this.insert(db, execution, operationId, {start:0,end:input.text.length,text:input.text,title:input.title,acquiredAt:input.acquiredAt,
        bindingId:input.bindingId,resource:input.resource,receiptDigest:input.receiptDigest,objectKey,
        manifest:createDependencyManifest([{kind:"connection",connectionId:binding.connection!.id,policyRevision:binding.connection!.policyRevision,resource:requestDigest(input.resource),catalogDigest:binding.catalog.digest}])});
    });
  }
  async recordProduct(taskId: string, operationId: string, input: ProductEvidenceInput): Promise<EvidencePassage> {
    boundedText(input.text); z.iso.datetime().parse(input.acquiredAt);
    if (!input.sources.length || input.sources.length > SOURCE_LIMITS.manifestNodes) throw integrity();
    return this.scoped(taskId, async (db, execution) => {
      if(!input.bindingId||!input.bindingDigest||!input.operationName)throw denied();
      const binding=execution.configuration.productBindings.find(value=>value.id===input.bindingId&&value.digest===input.bindingDigest);
      if(!binding?.authority||binding.authority.destinationProduct!==input.product||binding.authority.tenantId!==input.tenantId||binding.alias!==input.operationName)throw denied();
      await this.operation(db, taskId, operationId, [binding.alias]);
      const grant = (await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1", [execution.task.grant_id])).rows[0];
      if (!grant?.operations.includes("product.read")) throw denied();
      const manifest = createDependencyManifest(input.sources.map(source => ({ kind: "product" as const,
        product: input.product, tenantId: input.tenantId, taskId: execution.task.id,
        contextRevision: input.contextRevision,bindingId:input.bindingId,bindingDigest:input.bindingDigest, sourceId: source.id,
        ...(input.information ? { information: input.information } : {}) })));
      const prior = (await db.query(`SELECT e.id,e.content_digest,e.manifest,c.title FROM agents_platform.evidence_references e
        JOIN agents_platform.evidence_contents c ON c.reference_id=e.id WHERE e.task_id=$1 AND e.operation_id=$2 AND e.manifest=$3`, [taskId, operationId,manifest])).rows;
      if (prior.length) {
        if (prior.length !== 1 || prior[0].content_digest !== textDigest(input.text) || prior[0].manifest.digest !== manifest.digest || prior[0].title !== input.title.slice(0, 200)) throw integrity();
        return this.passage(db, taskId, prior[0].id);
      }
      return this.insert(db, execution, operationId, { start: 0, end: input.text.length, text: input.text,
        title: input.title, acquiredAt: input.acquiredAt, inlineContent: input.text, manifest });
    });
  }
  async recordMemory(taskId:string,operationId:string,memoryId:string,previewBytes?:number):Promise<EvidencePassage>{
    const initial=await loadExecution(this.pool,taskId);
    if(initial.task.principal.kind!=="human"||!initial.configuration.memory.enabled)throw denied();
    const row=(await this.pool.query(`SELECT m.*,s.organization_id,s.agent_id,s.account_id,s.generation,s.namespace,s.product,s.tenant_id,s.actor_issuer,s.actor_subject,s.client_id FROM agents_platform.memories m
      JOIN agents_platform.memory_scopes s ON s.id=m.scope_id WHERE m.id=$1`,[memoryId])).rows[0];
    if(!row||!await memoryScopeMatchesExecution(this.pool,initial,row)||row.status!=="accepted"||row.expires_at&&new Date(row.expires_at).getTime()<=Date.now())throw denied();
    if(textDigest(row.content)!==row.content_digest)throw integrity();
    boundedText(row.content);
    const text = previewBytes === undefined ? row.content : fitUtf8(row.content, z.number().int().positive().max(8192).parse(previewBytes));
    return this.scoped(taskId,async(db,execution)=>{
      await this.operation(db,taskId,operationId,["memory.search","memory.read"]);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("memory.read"))throw denied();
      const origin=await this.memoryOrigin(db,execution,memoryId);if(origin.row.revision!==row.revision||origin.row.content_digest!==row.content_digest)throw integrity();
      return this.insert(db,execution,operationId,{start:0,end:text.length,text,title:"Accepted memory, unverified",acquiredAt:new Date(row.updated_at).toISOString(),inlineContent:text,
        manifest:origin.manifest});
    });
  }
  private async passage(db: Db, taskId: string, evidenceId: string, retainedCitationIds:ReadonlySet<string>=new Set(),
    options: { execution?: Execution; verify?: boolean } = {}): Promise<EvidencePassage> {
    const execution = options.execution ?? await loadExecution(db, taskId);
    const row = (await db.query(`SELECT e.*,c.object_key,c.inline_content,c.title,c.page,c.section FROM agents_platform.evidence_references e
      JOIN agents_platform.evidence_contents c ON c.reference_id=e.id WHERE e.id=$1 AND e.organization_id=$2 AND (e.root_task_id=$3 OR EXISTS(
        SELECT 1 FROM agents_platform.evidence_nodes n WHERE n.task_id=$4 AND e.id=ANY(n.evidence_ids)) OR e.id=ANY($5::uuid[]))`, [evidenceId,execution.task.organization_id,execution.task.root_task_id,taskId,[...retainedCitationIds]])).rows[0];
    if (!row) throw denied();
    if(row.task_id!==taskId&&!retainedCitationIds.has(evidenceId)&&!(await suppliedNodes(db,execution)).some(node=>node.evidenceIds.includes(evidenceId)))throw denied();
    const reference = dto(row);
    if (options.verify !== false) await assertCurrentEvidence(db, taskId, reference.manifest, {requireActiveTask:false});
    let text: string;
    if (row.inline_content !== null) text = row.inline_content;
    else if (row.object_key) text = Buffer.from(await this.objectStore().get(row.object_key)).toString("utf8");
    else {
      const chunk = (await db.query("SELECT content,start_offset FROM agents_platform.source_chunks WHERE id=$1 AND organization_id=$2", [row.chunk_id,execution.task.organization_id])).rows[0];
      if (!chunk) throw unavailable();
      text = chunk.content.slice(row.start_offset-chunk.start_offset,row.end_offset-chunk.start_offset);
    }
    if (textDigest(text) !== row.content_digest) throw integrity();
    return {reference,label:row.citation_label,text,title:row.title,page:row.page,section:row.section};
  }
  private async node(db: PoolClient, execution: Execution, kind: EvidenceKind, ownerId: string, evidenceIds: string[], parents: EvidenceNode[], inherited?:{evidenceIds:string[];manifest:DependencyManifest}, replayParents:"fixed"|"recorded"="fixed", historyOriginTaskIds:string[]=[], passageManifests?:ReadonlyMap<string,DependencyManifest>): Promise<EvidenceNode> {
    const ids = [...new Set([...evidenceIds,...(inherited?.evidenceIds??[])])].sort(), parentIds = [...new Set(parents.map(parent=>parent.id))].sort();
    const existing = (await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(row=>({row,node:nodeDto(row)}));
    const graph = new Map(existing.map(({node})=>[node.id,node]));
    const prior = existing.find(({node})=>node.taskId===execution.task.id && node.kind===kind && node.ownerId===ownerId);
    if(prior){
      // Later evidence must not rewrite a recorded node's parents during replay.
      const recorded=prior.node;
      if(replayParents==="fixed" && requestDigest(recorded.parents)!==requestDigest(parentIds)) throw integrity();
      if(inherited?.manifest.dependencies.some(dependency=>!recorded.manifest.dependencies.some(prior=>requestDigest(prior)===requestDigest(dependency)))) throw integrity();
      if(requestDigest(recorded.evidenceIds)!==requestDigest(ids) || prior.row.request_digest!==requestDigest({ids:recorded.evidenceIds,parentIds:recorded.parents,manifest:recorded.manifest})) throw integrity();
      collectDependencyGraph([recorded.id],graph);
      await assertCurrentEvidence(db,execution.task.id,recorded.manifest,{historyOriginTaskIds});
      return recorded;
    }
    const dependencies: EvidenceDependency[] = [...await delegationDependency(db,execution.task.id),...parents.flatMap(parent=>parent.manifest.dependencies),...(inherited?.manifest.dependencies??[])];
    for (const id of evidenceIds) {
      const supplied = passageManifests?.get(id);
      dependencies.push(...(supplied ? supplied.dependencies : (await this.passage(db,execution.task.id,id)).reference.manifest.dependencies));
    }
    const manifest = createDependencyManifest(dependencies);
    collectDependencyGraph(parentIds,graph);
    const digest = requestDigest({ids,parentIds,manifest});
    const created=nodeDto((await db.query(`INSERT INTO agents_platform.evidence_nodes(id,organization_id,root_task_id,task_id,kind,owner_id,evidence_ids,parents,manifest,request_digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[randomUUID(),execution.task.organization_id,execution.task.root_task_id,execution.task.id,kind,ownerId,ids,parentIds,manifest,digest])).rows[0]);
    // The new join must be visible to lineage validation in this same transaction.
    await assertCurrentEvidence(db,execution.task.id,manifest,{historyOriginTaskIds});
    return created;
  }
  private async history(db:Db,execution:Execution,priorTaskId:string,selection?:{manifest:DependencyManifest;evidenceIds:string[];originNodeIds:string[]}):Promise<{taskId:string;eligible:boolean;omissionCode?:string;evidenceIds:string[];manifest:DependencyManifest;originNodeIds:string[]}>{
    const empty={taskId:priorTaskId,evidenceIds:[] as string[],manifest:createDependencyManifest([]),originNodeIds:[] as string[]};
    const prior=(await db.query(`SELECT * FROM agents_platform.tasks WHERE id=$1 AND organization_id=$2 AND conversation_id=$3
      AND turn_sequence<$4`,[priorTaskId,execution.task.organization_id,execution.task.conversation_id,execution.task.turn_sequence])).rows[0];
    if(!prior||!["completed","incomplete","refused","failed","cancelled","uncertain"].includes(prior.state)||(!execution.task.parent_task_id&&prior.parent_task_id))throw denied();
    let origin:Execution;
    try{origin=await loadExecution(db,prior.id);}
    catch(error){if(error instanceof PlatformError&&["PROGRAM_RELEASE_UNAVAILABLE","HARNESS_RELEASE_UNAVAILABLE","PROCEDURE_RELEASE_UNAVAILABLE"].includes(error.code))return {...empty,eligible:false,omissionCode:error.code};throw error;}
    if((execution.task.parent_task_id&&!await childHistoryAllowed(db,execution,origin))||!await historyPrincipalAllowed(db,execution,origin))throw denied();
    const rows=selection?[]:(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[prior.root_task_id])).rows.map(nodeDto);
    const roots=rows.filter(node=>node.taskId===priorTaskId),graph=new Map(rows.map(node=>[node.id,node]));
    const manifest=selection?.manifest??collectDependencyGraph(roots.map(node=>node.id),graph),ids=selection?.evidenceIds??[...evidenceGraphIds(roots.map(node=>node.id),graph)];
    try{await assertCurrentEvidence(db,prior.id,manifest,{requireActiveTask:false});await assertCurrentEvidence(db,execution.task.id,manifest,{historyOriginTaskIds:[prior.id]});}
    catch(error){if(error instanceof PlatformError&&["EVIDENCE_SCOPE_DENIED","EVIDENCE_UNAVAILABLE","GRANT_CAPABILITY_DENIED","EVIDENCE_LIMIT","PROGRAM_RELEASE_UNAVAILABLE","HARNESS_RELEASE_UNAVAILABLE","PROCEDURE_RELEASE_UNAVAILABLE"].includes(error.code))return{...empty,eligible:false,omissionCode:error.code};throw error;}
    return{taskId:priorTaskId,eligible:true,evidenceIds:[...ids].sort(),manifest,originNodeIds:selection?.originNodeIds??roots.map(node=>node.id)};
  }
  async checkHistory(taskId:string,priorTaskIds:string[]){
    return this.scoped(taskId,async(db,execution)=>{const results=[];for(const id of [...new Set(priorTaskIds)])results.push(await this.history(db,execution,id));return results;});
  }
  async recordHistoryRead(taskId:string,operationId:string,priorTaskIds:string[]):Promise<void>{
    return this.recordHistoryForOperation(taskId,operationId,priorTaskIds,["history.search","history.read"]);
  }
  async recordDelegationHistory(taskId:string,operationId:string,priorTaskIds:string[]):Promise<void>{
    return this.recordHistoryForOperation(taskId,operationId,priorTaskIds,["agents.start","agents.followup"]);
  }
  private async recordHistoryForOperation(taskId:string,operationId:string,priorTaskIds:string[],names:string[]):Promise<void>{
    await this.scoped(taskId,async(db,execution)=>{
      await this.operation(db,taskId,operationId,names);
      const origins=[];
      for(const id of [...new Set(priorTaskIds)]){const origin=await this.history(db,execution,id);if(!origin.eligible)throw unavailable();origins.push(origin);}
      const manifest=createDependencyManifest(origins.flatMap(origin=>origin.manifest.dependencies));
      const node=await this.node(db,execution,"input",`history-read:${operationId}`,[],[],{evidenceIds:origins.flatMap(origin=>origin.evidenceIds),manifest},"fixed",origins.map(origin=>origin.taskId));
      for(const origin of origins)await db.query("INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[node.id,origin.taskId,origin.originNodeIds]);
    });
  }
  async inheritHistory(taskId:string,snapshotId:string,priorTaskIds:string[],options:{allowSettled?:boolean}={}):Promise<EvidenceNode>{
    return this.scoped(taskId,async(db,execution)=>{
      const snapshot=(await db.query("SELECT payload FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2",[snapshotId,taskId])).rows[0];
      if(!snapshot||!Array.isArray(snapshot.payload.historyGroupIds))throw integrity();
      const selected=snapshot.payload.historyGroupIds as string[];
      if(requestDigest([...new Set(priorTaskIds)].sort())!==requestDigest([...new Set(selected)].sort()))throw integrity();
      const origins=[];for(const id of [...new Set(priorTaskIds)]){const prior=await this.history(db,execution,id);if(!prior.eligible)throw unavailable();origins.push(prior);}
      const manifest=createDependencyManifest(origins.flatMap(origin=>origin.manifest.dependencies));
      const node=await this.node(db,execution,"input",`history:${snapshotId}`,[],[],{evidenceIds:origins.flatMap(origin=>origin.evidenceIds),manifest},"fixed",origins.map(origin=>origin.taskId));
      for(const origin of origins)await db.query("INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[node.id,origin.taskId,origin.originNodeIds]);
      return node;
    },options);
  }
  /** A carried summary keeps its original policy graph after the covered history leaves the prompt. */
  async inheritCheckpoint(taskId:string,checkpointId:string):Promise<EvidenceNode>{
    return this.scoped(taskId,async(db,execution)=>{
      const checkpoint=(await db.query(`SELECT c.*,j.snapshot_id FROM agents_platform.context_continuity_checkpoints c
        JOIN agents_platform.context_compaction_jobs j ON j.id=c.id AND j.task_id=c.task_id
        WHERE c.id=$1 AND c.organization_id=$2 AND c.conversation_id=$3`,[checkpointId,execution.task.organization_id,execution.task.conversation_id])).rows[0];
      if(!checkpoint||requestDigest(checkpoint.summary)!==checkpoint.summary_digest)throw integrity();
      const origin=checkpoint.task_id===taskId?undefined:await this.history(db,execution,checkpoint.task_id);
      if(origin&&!origin.eligible)throw unavailable();
      const saved=checkpoint.source_manifest?assertDependencyManifest(checkpoint.source_manifest):createDependencyManifest([]);
      const origins=origin?[origin.taskId]:[];
      const prior=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='input' AND owner_id=$2",[taskId,`checkpoint:${checkpointId}`])).rows[0];
      if(prior)return this.node(db,execution,"input",`checkpoint:${checkpointId}`,prior.evidence_ids,[],{
        manifest:saved,evidenceIds:prior.evidence_ids,
      },"recorded",origins);
      const producer=(await db.query(`SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1
        AND ((kind='summary' AND owner_id=$2) OR (kind='context' AND owner_id=$3))
        ORDER BY CASE WHEN kind='context' THEN 0 ELSE 1 END,id LIMIT 1`,[checkpoint.task_id,checkpointId,checkpoint.snapshot_id])).rows[0];
      const source=producer?nodeDto(producer):undefined;
      const manifest=createDependencyManifest([...saved.dependencies,...(source?.manifest.dependencies??origin?.manifest.dependencies??[])]);
      const node=await this.node(db,execution,"input",`checkpoint:${checkpointId}`,[],source?.taskId===taskId?[source]:[],{
        manifest,evidenceIds:source?.evidenceIds??origin?.evidenceIds??[],
      },"fixed",origins);
      if(origin)await db.query(`INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids)
        VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[node.id,origin.taskId,source?[source.id]:origin.originNodeIds]);
      return node;
    });
  }
  private async memoryOrigin(db:Db,execution:Execution,memoryId:string){
    if(execution.task.principal.kind!=="human"||!execution.configuration.memory.enabled)throw denied();
    const row=(await db.query(`SELECT m.*,s.organization_id,s.agent_id,s.account_id,s.generation,s.namespace,s.product,s.tenant_id,s.actor_issuer,s.actor_subject,s.client_id FROM agents_platform.memories m
      JOIN agents_platform.memory_scopes s ON s.id=m.scope_id WHERE m.id=$1`,[memoryId])).rows[0];
    if(!row||!await memoryScopeMatchesExecution(db,execution,row)||row.status!=="accepted"||row.expires_at&&new Date(row.expires_at).getTime()<=Date.now()||textDigest(row.content)!==row.content_digest)throw unavailable();
    let roots:EvidenceNode[]=[],nodes:EvidenceNode[]=[];
    if(row.source_task_id){
      const source=await loadExecution(db,row.source_task_id);
      if(!await memoryScopeMatchesExecution(db,source,row,false))throw denied();
      await inspectionAuthority(db,source);
      nodes=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[source.task.root_task_id])).rows.map(nodeDto);
      roots=nodes.filter(node=>node.taskId===row.source_task_id&&node.kind==="memory"&&node.ownerId===memoryId);
      if(!roots.length)roots=nodes.filter(node=>node.taskId===row.source_task_id);
    }
    const graph=new Map(nodes.map(node=>[node.id,node])),origin=collectDependencyGraph(roots.map(node=>node.id),graph);
    const dependencies = row.namespace === "product_actor" ? origin.dependencies.map(dependency => dependency.kind === "product" || dependency.kind === "product_access" || dependency.kind === "product_context" || dependency.kind === "product_artifact" || dependency.kind === "delegation_input"
      ? { ...dependency, memoryTransition: { memoryId: row.id, memoryRevision: Number(row.revision) } } : dependency) : origin.dependencies;
    const manifest=createDependencyManifest([...dependencies,{kind:"memory",referenceId:row.scope_id,generation:Number(row.revision),memoryId:row.id,memoryRevision:Number(row.revision)}]);
    await assertCurrentEvidence(db,execution.task.id,manifest);
    const evidenceIds=evidenceGraphIds(roots.map(node=>node.id),graph);
    return{row,manifest,evidenceIds:row.namespace === "product_actor" ? [] : [...evidenceIds]};
  }
  async checkMemories(taskId:string,memoryIds:string[]){
    if(memoryIds.length>100)throw new PlatformError("EVIDENCE_LIMIT",413,"Too many memory records");
    return this.scoped(taskId,async(db,execution)=>{const results=[];for(const id of [...new Set(memoryIds)]){
      try{const origin=await this.memoryOrigin(db,execution,id);results.push({id,eligible:true,manifest:origin.manifest});}
      catch(error){if(error instanceof PlatformError&&["EVIDENCE_SCOPE_DENIED","EVIDENCE_UNAVAILABLE","GRANT_CAPABILITY_DENIED"].includes(error.code))results.push({id,eligible:false,omissionCode:error.code});else throw error;}
    }return results;});
  }
  async supplyContext(taskId: string, snapshotId: string, evidenceIds: string[], continuationEvidenceIds:string[]=[]): Promise<EvidenceNode> {
    return this.scoped(taskId, async (db, execution) => {
      const snapshot = (await db.query("SELECT * FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2",[snapshotId,taskId])).rows[0];
      if (!snapshot) throw denied();
      const passages:EvidencePassage[]=[];
      for (const id of evidenceIds) {
        const passage = await this.passage(db,taskId,id,undefined,{execution,verify:false});
        if (!payloadHas(snapshot.payload,passage.text,passage.label)) throw integrity();
        passages.push(passage);
      }
      // Passages from the same source share one manifest; verify each distinct manifest once.
      const manifests=new Map<string,DependencyManifest>();
      for(const passage of passages)manifests.set(requestDigest(passage.reference.manifest),passage.reference.manifest);
      for(const manifest of manifests.values())await assertCurrentEvidence(db,taskId,manifest,{requireActiveTask:false});
      const parents = await this.currentParents(db,execution);
      const selectedMemories=(snapshot.source_references??[]).filter((reference:{kind?:string})=>reference.kind==="memory");
      const memoryDependencies:EvidenceDependency[]=[],inheritedIds:string[]=[];
      if(snapshot.payload.selectedProductContext){
        const selection=snapshot.payload.selectedProductContext,dependency=evidenceDependencySchema.parse(selection.dependency);
        if(dependency.kind!=="product_context"||dependency.taskId!==taskId||execution.task.parent_task_id||
          requestDigest(selection.reference)!==dependency.referenceDigest||!Array.isArray(snapshot.payload.messages)||
          !snapshot.payload.messages.some((message:{role?:unknown;content?:unknown})=>message.role==="user"&&typeof message.content==="string"&&message.content.includes(selectedProductContextText(selection.reference))))throw integrity();
        memoryDependencies.push(dependency);
      }
      for(const selected of snapshot.source_references??[])if(selected.kind==="skill"&&selected.skillFile)
        memoryDependencies.push({kind:"skill",skillId:selected.id,agentId:execution.agentId,packageDigest:selected.skillFile.packageDigest});
      const checkpoint=snapshot.payload.continuation?.checkpoint?.evidence??[],recordedIds=snapshot.payload.continuationEvidenceIds??[];
      if(!Array.isArray(recordedIds)||!Array.isArray(checkpoint)||continuationEvidenceIds.length>12||requestDigest(continuationEvidenceIds)!==requestDigest(recordedIds)||requestDigest(recordedIds)!==requestDigest(checkpoint.map((item:{id?:unknown})=>item?.id)))throw integrity();
      if(continuationEvidenceIds.length){
        const supplied=new Set((await suppliedNodes(db,execution)).flatMap(node=>node.evidenceIds));
        const rows=(await db.query("SELECT e.id,e.citation_label,e.operation_id,e.source_id,e.manifest,c.binding_id FROM agents_platform.evidence_references e JOIN agents_platform.evidence_contents c ON c.reference_id=e.id WHERE e.organization_id=$1 AND e.id=ANY($2::uuid[])",[execution.task.organization_id,continuationEvidenceIds])).rows;
        for(const item of checkpoint){const row=rows.find(row=>row.id===item.id),kind=row?.binding_id?"connection":row?.source_id?"source":row?.manifest?.dependencies?.some((dependency:EvidenceDependency)=>dependency.kind==="product")?"product":"memory";
          if(!row||!supplied.has(item.id)||item.citation!==`[${row.citation_label}]`||item.operationId!==row.operation_id||item.kind!==kind)throw integrity();inheritedIds.push(item.id);}
      }
      for(const selected of selectedMemories){const origin=await this.memoryOrigin(db,execution,selected.id);
        if(!memoryVisible(snapshot.payload,selected.id,origin.row.content))throw integrity();
        if(origin.row.revision!==selected.revision||origin.row.scope_id!==snapshot.memory_scope_id||Number(origin.row.generation)!==Number(snapshot.memory_generation))throw integrity();
        memoryDependencies.push(...origin.manifest.dependencies);inheritedIds.push(...origin.evidenceIds);}
      return this.node(db,execution,"context",snapshotId,evidenceIds,parents,{manifest:createDependencyManifest(memoryDependencies),evidenceIds:inheritedIds},"recorded",[],
        new Map(passages.map(passage=>[passage.reference.id,passage.reference.manifest])));
    });
  }
  async inheritArtifactWithin(db:PoolClient,targetTaskId:string,artifactId:string):Promise<EvidenceNode>{
    const execution=await loadExecution(db,targetTaskId);await assertCurrentAuthority(db,execution);
    const retained=(await db.query(`SELECT n.* FROM agents_platform.evidence_nodes n
      JOIN agents_platform.evidence_history_links h ON h.node_id=n.id
      JOIN agents_platform.evidence_nodes original ON original.id=ANY(h.origin_node_ids)
      JOIN agents_platform.artifacts a ON a.id=$2 AND a.task_id=original.task_id AND a.root_task_id=original.root_task_id
      WHERE n.task_id=$1 AND n.kind='input' AND n.owner_id='retained-artifact:'||$2::text
        AND original.kind='artifact' AND original.owner_id=$2::text AND a.state='available'`,[targetTaskId,artifactId])).rows[0];
    if(retained){const node=nodeDto(retained);await assertCurrentEvidence(db,targetTaskId,node.manifest);return node;}
    const row=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1 AND kind='artifact' AND owner_id=$2 AND organization_id=$3",[execution.task.root_task_id,artifactId,execution.task.organization_id])).rows[0];
    if(row)return this.node(db,execution,"input",`artifact:${artifactId}`,[],[nodeDto(row)]);
    const transferred=(await db.query(`SELECT n.*,a.content_digest FROM agents_platform.task_artifact_transfers x
      JOIN agents_platform.tasks t ON t.id=x.target_task_id AND t.parent_task_id=x.granted_by_task_id
      JOIN agents_platform.artifacts a ON a.id=x.artifact_id AND a.organization_id=t.organization_id AND a.state='available'
      JOIN agents_platform.evidence_nodes n ON n.task_id=x.granted_by_task_id AND n.root_task_id=t.root_task_id AND n.kind='input'
        AND n.owner_id IN ('retained-artifact:'||a.id::text,'artifact:'||a.id::text)
      WHERE x.target_task_id=$1 AND x.artifact_id=$2
      ORDER BY (n.owner_id='retained-artifact:'||a.id::text) DESC,n.id LIMIT 1`,[targetTaskId,artifactId])).rows[0];
    if(!transferred)throw unavailable();
    return this.node(db,execution,"input",`artifact:${artifactId}`,[],[nodeDto(transferred)],
      {evidenceIds:[],manifest:createDependencyManifest([{kind:"artifact",referenceId:artifactId,contentDigest:transferred.content_digest}])});
  }
  /** Recover exactly one historical artifact without importing another root's browsing or control authority. */
  private async retainedArtifactOrigin(db:PoolClient,execution:Execution,originTaskId:string,artifactId:string,validatedSources=createDependencyManifest([])){
    const original=await loadExecution(db,originTaskId);
    if(original.task.product!==execution.task.product||original.agentId!==execution.agentId||
      original.task.resource_id!==execution.task.resource_id||original.task.caller_client_id!==execution.task.caller_client_id)throw denied();
    const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
    if(!grant?.operations.includes("artifact.read"))throw denied();
    const row=(await db.query(`SELECT n.* FROM agents_platform.artifacts a
      JOIN agents_platform.evidence_nodes n ON n.task_id=a.task_id AND n.root_task_id=a.root_task_id AND n.kind='artifact' AND n.owner_id=a.id::text
      WHERE a.id=$1 AND a.organization_id=$2 AND a.root_task_id=$3 AND a.state='available'
        AND (a.task_id=$4 OR $4=$3 OR EXISTS(SELECT 1 FROM agents_platform.task_artifact_transfers x WHERE x.artifact_id=a.id AND x.target_task_id=$4))`,
    [artifactId,execution.task.organization_id,original.task.root_task_id,originTaskId])).rows[0];
    if(!row)throw unavailable();
    const source=nodeDto(row),manifest=createDependencyManifest([...source.manifest.dependencies,...assertDependencyManifest(validatedSources).dependencies]);
    const history=await this.history(db,execution,originTaskId,{manifest,evidenceIds:[],originNodeIds:[source.id]});
    if(!history.eligible)throw unavailable();
    await assertCurrentEvidence(db,source.taskId,manifest,{requireActiveTask:false});
    return{source,manifest};
  }
  async checkRetainedArtifactHistory(taskId:string,originTaskId:string,artifactId:string,validatedSources?:DependencyManifest):Promise<void>{
    await this.scoped(taskId,async(db,execution)=>{await this.retainedArtifactOrigin(db,execution,originTaskId,artifactId,validatedSources);});
  }
  async retainArtifactMetadata(taskId:string,operationId:string,selections:{originTaskId:string;artifactId:string;manifest:DependencyManifest}[]):Promise<void>{
    if(!selections.length)return;
    await this.scoped(taskId,async(db,execution)=>{
      await this.operation(db,taskId,operationId,["history.search"]);
      const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
      if(!grant?.operations.includes("artifact.read"))throw denied();
      const dependencies:EvidenceDependency[]=[],origins=new Map<string,string[]>();
      for(const selected of selections){
        if(selected.originTaskId===taskId){
          const row=(await db.query(`SELECT n.* FROM agents_platform.artifacts a JOIN agents_platform.evidence_nodes n
            ON n.task_id=a.task_id AND n.kind='artifact' AND n.owner_id=a.id::text
            WHERE a.id=$1 AND a.organization_id=$2 AND a.root_task_id=$3 AND a.state='available'
            AND (a.task_id=$4 OR $4=$3 OR EXISTS(SELECT 1 FROM agents_platform.task_artifact_transfers x WHERE x.artifact_id=a.id AND x.target_task_id=$4))`,
          [selected.artifactId,execution.task.organization_id,execution.task.root_task_id,taskId])).rows[0];
          if(!row)throw unavailable();
          const manifest=createDependencyManifest([...nodeDto(row).manifest.dependencies,...assertDependencyManifest(selected.manifest).dependencies]);
          await assertCurrentEvidence(db,taskId,manifest);dependencies.push(...manifest.dependencies);
        }else{
          const {source,manifest}=await this.retainedArtifactOrigin(db,execution,selected.originTaskId,selected.artifactId,selected.manifest);
          dependencies.push(...manifest.dependencies);
          origins.set(selected.originTaskId,[...origins.get(selected.originTaskId)??[],source.id]);
        }
      }
      // Metadata retains dependency fences, not artifact bytes, passage IDs or read authority.
      const node=await this.node(db,execution,"input",`artifact-metadata:${operationId}`,[],[],{evidenceIds:[],manifest:createDependencyManifest(dependencies)},"fixed",[...origins.keys()]);
      for(const [originTaskId,nodeIds] of origins)await db.query("INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[node.id,originTaskId,[...new Set(nodeIds)]]);
    });
  }
  async inheritRetainedArtifactWithin(db:PoolClient,targetTaskId:string,originTaskId:string,artifactId:string,validatedSources:DependencyManifest):Promise<EvidenceNode>{
    const execution=await loadExecution(db,targetTaskId);await assertCurrentAuthority(db,execution);
    const {source,manifest}=await this.retainedArtifactOrigin(db,execution,originTaskId,artifactId,validatedSources);
    const node=await this.node(db,execution,"input",`retained-artifact:${artifactId}`,[],[],{manifest,evidenceIds:[]},"fixed",[originTaskId]);
    await db.query("INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[node.id,originTaskId,[source.id]]);
    return node;
  }
  private async retainedCitationIds(db:Db,execution:Execution,nodeIds:readonly string[]):Promise<Set<string>>{
    if(!nodeIds.length)return new Set();
    const rows=(await db.query(`SELECT DISTINCT c.reference_id FROM agents_platform.evidence_nodes n
      JOIN agents_platform.evidence_history_links h ON h.node_id=n.id
      JOIN agents_platform.evidence_nodes original ON original.id=ANY(h.origin_node_ids)
      JOIN agents_platform.artifacts a ON a.id::text=original.owner_id AND a.task_id=original.task_id AND a.root_task_id=original.root_task_id
      JOIN agents_platform.artifact_citations c ON c.artifact_id=a.id
      WHERE n.id=ANY($1::uuid[]) AND n.organization_id=$2 AND n.root_task_id=$3 AND n.kind='input'
        AND n.owner_id='retained-artifact:'||a.id::text AND original.kind='artifact'
        AND a.organization_id=$2 AND a.state='available'`,[nodeIds,execution.task.organization_id,execution.task.root_task_id])).rows;
    return new Set(rows.map(row=>row.reference_id));
  }
  /** Register literal report citations separately from passages supplied to a model. */
  async recordArtifactCitationsWithin(db:PoolClient,taskId:string,artifactId:string,content:Uint8Array):Promise<void>{
    const artifact=(await db.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 AND task_id=$2",[artifactId,taskId])).rows[0];
    if(!artifact||artifact.content_digest!==textDigest(content))throw integrity();
    let text:string;try{text=new TextDecoder("utf8",{fatal:true,ignoreBOM:true}).decode(content);}catch{return;}
    const labels=citationLabels(text);if(!labels.length)return;
    const execution=await loadExecution(db,taskId);
    const nodes=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto);
    const source=nodes.find(node=>node.taskId===taskId&&node.kind==='artifact'&&node.ownerId===artifactId);
    if(!source)throw integrity();const graph=new Map(nodes.map(node=>[node.id,node]));collectDependencyGraph([source.id],graph);
    const reachable=new Set<string>(),ids=evidenceGraphIds([source.id],graph,reachable);
    for(const id of await this.retainedCitationIds(db,execution,[...reachable]))ids.add(id);
    const rows=ids.size?(await db.query("SELECT id,manifest FROM agents_platform.evidence_references WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND citation_label=ANY($3::text[])",[execution.task.organization_id,[...ids],labels])).rows:[];
    for(const row of rows){
      await assertCurrentEvidence(db,taskId,assertDependencyManifest(row.manifest),{requireActiveTask:false});
      await db.query("INSERT INTO agents_platform.artifact_citations(artifact_id,reference_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[artifactId,row.id]);
    }
  }
  async deriveWithin(db:PoolClient,taskId:string,kind:Exclude<EvidenceKind,"context">,ownerId:string,dependencies:EvidenceDependency[]=[]):Promise<EvidenceNode>{
    const execution=await loadExecution(db,taskId);await assertCurrentAuthority(db,execution);
    const parents=await this.currentParents(db,execution,{kind,ownerId});
    return this.node(db,execution,kind,ownerId,[],parents,{manifest:createDependencyManifest(dependencies),evidenceIds:[]},"recorded");
  }
  async artifactManifest(db:Db,taskId:string,artifactId:string):Promise<DependencyManifest>{
    const artifact=(await db.query("SELECT task_id FROM agents_platform.artifacts WHERE id=$1",[artifactId])).rows[0];
    const execution=await loadExecution(db,taskId);
    const row=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='artifact' AND owner_id=$2 AND organization_id=$3 AND root_task_id=$4",[artifact?.task_id,artifactId,execution.task.organization_id,execution.task.root_task_id])).rows[0];
    if(!row)throw unavailable();const manifest=assertDependencyManifest(row.manifest);await assertCurrentEvidence(db,taskId,manifest,{requireActiveTask:false});return manifest;
  }
  async derive(taskId: string, kind: Exclude<EvidenceKind,"context">, ownerId: string): Promise<EvidenceNode> {
    return this.scoped(taskId, async (db, execution) => {
      const parents = await this.currentParents(db,execution,{kind,ownerId});
      return this.node(db,execution,kind,ownerId,[],parents,undefined,"recorded");
    });
  }
  async deriveSummaryFromSnapshot(taskId:string,ownerId:string,snapshotId:string,options:{allowSettled?:boolean}={}):Promise<EvidenceNode> {
    return this.scoped(taskId,async(db,execution)=>{
      const parents=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='context' AND owner_id=$2",[taskId,snapshotId])).rows.map(nodeDto);
      if(parents.length!==1)throw integrity();
      return this.node(db,execution,"summary",ownerId,[],parents,undefined,"recorded");
    },options);
  }
  async joinChildren(taskId: string, operationId: string): Promise<EvidenceNode> {
    return this.scoped(taskId, async (db, execution) => {
      await this.operation(db,taskId,operationId);
      const operation=(await db.query("SELECT kind FROM agents_platform.operations WHERE id=$1 AND task_id=$2",[operationId,taskId])).rows[0];
      if(operation?.kind!=="delegation")throw denied();
      const children = (await db.query(`SELECT n.* FROM agents_platform.evidence_nodes n JOIN agents_platform.tasks t ON t.id=n.task_id
        JOIN agents_platform.delegations d ON d.child_task_id=t.id
        WHERE d.parent_task_id=$1 AND d.operation_id=$2 AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain') AND t.output IS NOT NULL AND n.kind='child_result' ORDER BY n.id`,[taskId,operationId])).rows.map(nodeDto);
      return this.node(db,execution,"input",operationId,[],children);
    });
  }
  async joinChild(taskId:string,operationId:string,childTaskId:string):Promise<EvidenceNode>{
    return this.scoped(taskId,async(db,execution)=>{
      await this.operation(db,taskId,operationId,["agents.result","agents.wait"]);
      const child=(await db.query(`SELECT t.id,t.state,t.output,t.parent_task_id,t.root_task_id FROM agents_platform.tasks t
        JOIN agents_platform.delegations d ON d.child_task_id=t.id
        JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
        WHERE t.id=$1 AND t.parent_task_id=d.parent_task_id
          AND t.organization_id=$2 FOR SHARE OF c`,[childTaskId,execution.task.organization_id])).rows[0];
      if(!child)throw denied();
      const priorSegment=child.parent_task_id!==taskId;
      if(priorSegment&&!await continuationChildAllowed(db,execution,await loadExecution(db,child.id)))throw denied();
      if(!["completed","incomplete","refused","failed","cancelled","uncertain"].includes(child.state))throw new PlatformError("CHILD_OUTCOME_PENDING",409,"Specialist outcome is not yet available");
      await assertCurrentEvidence(db,child.id,await taskEvidenceManifest(db,child.id),{requireActiveTask:false});
      const parents=child.output===null?[]:(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 AND kind='child_result' ORDER BY id",[child.id])).rows.map(nodeDto);
      if(child.output!==null&&!parents.length)throw integrity();
      if(priorSegment){
        const rows=(await db.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[child.root_task_id])).rows.map(nodeDto);
        const graph=new Map(rows.map(node=>[node.id,node])),manifest=collectDependencyGraph(parents.map(node=>node.id),graph);
        const ids=evidenceGraphIds(parents.map(node=>node.id),graph);
        const node=await this.node(db,execution,"input",`${operationId}:${childTaskId}`,[],[],{evidenceIds:[...ids],manifest},"fixed",[child.parent_task_id,child.id]);
        for(const origin of [{id:child.parent_task_id,nodes:rows.filter(item=>item.taskId===child.parent_task_id).map(item=>item.id)},{id:child.id,nodes:parents.map(item=>item.id)}])
          await db.query("INSERT INTO agents_platform.evidence_history_links(node_id,origin_task_id,origin_node_ids) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[node.id,origin.id,origin.nodes]);
        return node;
      }
      return this.node(db,execution,"input",`${operationId}:${childTaskId}`,[],parents);
    });
  }
  async validateCitations(taskId: string, text: string): Promise<EvidencePassage[]> {
    const execution = await loadExecution(this.pool,taskId);
    const rows = (await this.pool.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 ORDER BY created_at,id",[taskId])).rows.map(nodeDto);
    const all = (await this.pool.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto);
    const graph = new Map(all.map(node=>[node.id,node])); collectDependencyGraph(rows.map(node=>node.id),graph);
    const reachable=new Set<string>(),supplied=evidenceGraphIds(rows.map(node=>node.id),graph,reachable);
    const retained=await this.retainedCitationIds(this.pool,execution,[...reachable]);
    for(const id of retained)supplied.add(id);
    const references = supplied.size ? (await this.pool.query("SELECT id,citation_label FROM agents_platform.evidence_references WHERE id=ANY($1::uuid[])",[[...supplied]])).rows : [];
    const passages:EvidencePassage[]=[];
    for(const label of citationLabels(text)){const reference=references.find(row=>row.citation_label===label);if(!reference)throw new PlatformError("CITATION_UNKNOWN",422,"Report contains a citation that was not supplied to this task");passages.push(await this.passage(this.pool,taskId,reference.id,retained));}
    return passages;
  }
  async readPassage(taskId:string,evidenceId:string):Promise<EvidencePassage>{return this.passage(this.pool,taskId,evidenceId);}
  async suppliedEvidence(taskId:string,limit=12):Promise<{items:{id:string;citation:string;operationId:string;kind:"source"|"connection"|"memory"|"product"}[];omittedCount:number}>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>12)throw new PlatformError("EVIDENCE_LIMIT",413,"Evidence index limit is invalid");
    return this.scoped(taskId,async(db,execution)=>{
      await assertCurrentEvidence(db,taskId,await taskEvidenceManifest(db,taskId));
      const ids=[...new Set((await suppliedNodes(db,execution)).flatMap(node=>node.evidenceIds))];
      const rows=ids.length?(await db.query("SELECT e.id,e.citation_label,e.operation_id,e.manifest,c.binding_id,e.source_id FROM agents_platform.evidence_references e JOIN agents_platform.evidence_contents c ON c.reference_id=e.id WHERE e.organization_id=$1 AND e.id=ANY($2::uuid[]) ORDER BY e.citation_label",[execution.task.organization_id,ids])).rows:[];
      return{items:rows.slice(0,limit).map(row=>({id:row.id,citation:`[${row.citation_label}]`,operationId:row.operation_id,kind:row.binding_id?"connection" as const:row.source_id?"source" as const:row.manifest.dependencies.some((dependency:EvidenceDependency)=>dependency.kind==="product")?"product" as const:"memory" as const})),omittedCount:Math.max(0,rows.length-limit)};
    });
  }
  async operationEvidenceIds(taskId:string,operationId:string):Promise<string[]>{
    await this.operation(this.pool,taskId,operationId);
    return(await this.pool.query("SELECT id FROM agents_platform.evidence_references WHERE task_id=$1 AND operation_id=$2 ORDER BY citation_label",[taskId,operationId])).rows.map(row=>row.id);
  }
  private async operationReceiptManifest(db:PoolClient,execution:Execution,operationId:string,originTaskId=execution.task.id):Promise<DependencyManifest>{
    const historical=originTaskId===execution.task.id?undefined:await this.history(db,execution,originTaskId);
    if(historical&&!historical.eligible)throw unavailable();
    const origin=originTaskId===execution.task.id?execution:await loadExecution(db,originTaskId);
    const row=(await db.query(`SELECT name,state,output,request FROM agents_platform.operations WHERE id=$1 AND task_id=$2
      AND kind IN ('tool','delegation','resource') AND state IN ('completed','failed','uncertain')
      AND name NOT IN ('history.search','history.read')`,[operationId,originTaskId])).rows[0];
    if(!row)throw new PlatformError("HISTORY_UNAVAILABLE",404,"The retained receipt is unavailable");
    const dependencies:EvidenceDependency[]=[...(await taskEvidenceManifest(db,execution.task.id)).dependencies,...(historical?.manifest.dependencies??[])];
    if(row.state==="completed"&&row.request?.productBindingId){
      const binding=origin.configuration.productBindings.find(value=>value.id===row.request.productBindingId&&value.digest===row.request.bindingDigest);
      if(!binding)throw integrity();
      if(requiresProductAccess(binding)){
        const access=(await db.query("SELECT * FROM agents_platform.product_operation_access WHERE operation_id=$1 AND task_id=$2",[operationId,originTaskId])).rows[0];
        if(!access||access.binding_id!==binding.id||access.binding_digest!==binding.digest||requestDigest(row.output?.value)!==access.result_digest)throw unavailable();
        dependencies.push({kind:"product_access",product:binding.authority!.destinationProduct,tenantId:binding.authority!.tenantId,taskId:originTaskId,
          bindingId:binding.id,bindingDigest:binding.digest,reference:access.scope_reference,information:access.information});
      }
    }
    const references=(await db.query("SELECT id FROM agents_platform.evidence_references WHERE task_id=$1 AND operation_id=$2 ORDER BY id",[originTaskId,operationId])).rows;
    for(const reference of references)dependencies.push(...(await this.passage(db,originTaskId,reference.id)).reference.manifest.dependencies);
    if(row.state==="completed"&&(row.name==="skills.activate"||row.name==="skills.read")){
      const output=z.object({skillId:z.uuid(),evidence:z.object({packageDigest:z.string().regex(/^[a-f0-9]{64}$/)})}).safeParse(row.output);
      if(!output.success)throw integrity();
      dependencies.push({kind:"skill",agentId:origin.agentId,skillId:output.data.skillId,packageDigest:output.data.evidence.packageDigest});
    }
    if(row.name==="skills.run"){
      const script=(await db.query("SELECT skill_revision_id,package_digest FROM agents_platform.skill_script_executions WHERE operation_id=$1 AND task_id=$2 AND organization_id=$3 AND agent_id=$4",[operationId,originTaskId,execution.task.organization_id,origin.agentId])).rows[0];
      if(row.state==="completed"&&!script)throw integrity();
      if(script)dependencies.push({kind:"skill",agentId:origin.agentId,skillId:script.skill_revision_id,packageDigest:script.package_digest});
    }
    const manifest=createDependencyManifest(dependencies);await assertCurrentEvidence(db,execution.task.id,manifest,{historyOriginTaskIds:originTaskId===execution.task.id?[]:[originTaskId]});
    return manifest;
  }
  /** Validate source custody before a receipt can affect search matching or disclose any text. */
  async validateOperation(taskId:string,operationId:string,originTaskId=taskId):Promise<void>{
    await this.scoped(taskId,async(db,execution)=>{await this.operationReceiptManifest(db,execution,operationId,originTaskId);});
  }
  /** Retain provenance without claiming the complete original passages were supplied to the model. */
  async retainOperation(taskId:string,operationId:string,originTaskId=taskId):Promise<EvidenceNode>{
    return this.scoped(taskId,async(db,execution)=>{
      const manifest=await this.operationReceiptManifest(db,execution,operationId,originTaskId);
      const parents=await this.currentParents(db,execution);
      return this.node(db,execution,"input",`operation-receipt:${operationId}`,[],parents,{manifest,evidenceIds:[]},"recorded",originTaskId===taskId?[]:[originTaskId]);
    });
  }
  async taskManifest(taskId:string):Promise<DependencyManifest>{
    return taskEvidenceManifest(this.pool,taskId);
  }
  /** Sources for answers that carry no inline handles: the retained evidence supplied to this task. */
  async suppliedPassages(taskId:string,limit=20):Promise<EvidencePassage[]>{
    const execution=await loadExecution(this.pool,taskId);
    const rows=(await this.pool.query("SELECT * FROM agents_platform.evidence_nodes WHERE task_id=$1 ORDER BY created_at,id",[taskId])).rows.map(nodeDto);
    const all=(await this.pool.query("SELECT * FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[execution.task.root_task_id])).rows.map(nodeDto);
    const graph=new Map(all.map(node=>[node.id,node]));collectDependencyGraph(rows.map(node=>node.id),graph);
    const reachable=new Set<string>();evidenceGraphIds(rows.map(node=>node.id),graph,reachable);
    const retained=await this.retainedCitationIds(this.pool,execution,[...reachable]);
    const references=(await this.pool.query(`SELECT id FROM agents_platform.evidence_references
      WHERE task_id=$1 AND organization_id=$2 ORDER BY citation_label LIMIT $3`,
      [taskId,execution.task.organization_id,Math.min(Math.max(limit,1),50)])).rows as {id:string}[];
    const passages:EvidencePassage[]=[];
    for(const reference of references)passages.push(await this.passage(this.pool,taskId,reference.id,retained));
    return passages;
  }
  /** Designated reviewers can inspect cited passages only, never arbitrary root evidence or private inputs. */
  async reviewerPassages(scope:{organizationId:string;accountId:string},taskId:string,artifactId:string):Promise<EvidencePassage[]>{
    return transaction(this.pool,db=>this.reviewerPassagesWithin(db,scope,taskId,artifactId));
  }
  async reviewerPassagesWithin(db:PoolClient,scope:{organizationId:string;accountId:string},taskId:string,artifactId:string):Promise<EvidencePassage[]>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)throw denied();
      const action=(await db.query(`SELECT a.artifact_digest FROM agents_platform.actions a JOIN agents_platform.artifacts f ON f.id=a.artifact_id
        WHERE a.task_id=$1 AND a.organization_id=$2 AND a.artifact_id=$3 AND (a.account_id=$4 OR a.reviewer_account_id=$4)
        AND f.state='available' AND f.content_digest=a.artifact_digest`,[taskId,scope.organizationId,artifactId,scope.accountId])).rows[0];
      if(!action)throw denied();
      await assertCurrentEvidence(db,taskId,await taskEvidenceManifest(db,taskId),{requireActiveTask:false});
      const references=(await db.query("SELECT reference_id FROM agents_platform.artifact_citations WHERE artifact_id=$1 ORDER BY reference_id",[artifactId])).rows;
      const execution=await loadExecution(db,taskId),nodes=await suppliedNodes(db,execution);
      const retained=await this.retainedCitationIds(db,execution,nodes.map(node=>node.id));
      const passages:EvidencePassage[]=[];for(const row of references)passages.push(await this.passage(db,taskId,row.reference_id,retained));return passages;
  }
  async verifyQuote(taskId:string,evidenceId:string,quote:string):Promise<boolean>{if(!quote.length)return false;return(await this.passage(this.pool,taskId,evidenceId)).text.includes(quote);}
  async validateReport(taskId:string,artifactId:string,text:string):Promise<EvidencePassage[]>{
    const passages=await this.validateCitations(taskId,text);
    await this.scoped(taskId,async(db,execution)=>{
      const artifact=(await db.query("SELECT content_digest FROM agents_platform.artifacts WHERE id=$1 AND task_id=$2 AND organization_id=$3",[artifactId,taskId,execution.task.organization_id])).rows[0];
      if(!artifact||artifact.content_digest!==textDigest(text))throw integrity();
      for(const passage of passages){await assertCurrentEvidence(db,taskId,passage.reference.manifest);await db.query("INSERT INTO agents_platform.artifact_citations(artifact_id,reference_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[artifactId,passage.reference.id]);}
    });return passages;
  }
}
