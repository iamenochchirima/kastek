import type { Pool } from "pg";
import { canonicalJson, PlatformError, requestDigest } from "../../contracts/contracts";
import { assertCurrentAuthority, loadExecution } from "../lifecycle/execution";
import { fitUtf8 } from "../../infrastructure/utf8";
import type { EvidenceStore } from "./evidence";
import { assertCurrentEvidence } from "./evidence-policy";
import { historyReadInputSchema, historySearchInputSchema, type HistoryResult } from "../../contracts/history";
import { specialistHistoryReferenceSchema } from "../../contracts/orchestration";
import { TaskArtifactStore } from "../artifacts/task-artifacts";
import type { DependencyManifest } from "../../contracts/source-contracts";
import type { Execution } from "../../contracts/execution";
import { productModelResult } from "../products/product-result";
import { projectProductReferences } from "../products/product-references";
import { connectedModelView } from "../../capabilities/connected-tools/connected-model-view";
import type { ConnectedObservation } from "../../capabilities/connected-tools/connected-executor";
import { builtinObservationView } from "../../capabilities/tool-observation-feedback";
export { historyResultBytes } from "../../contracts/history";
export { historyTools, historyToolDefinitions } from "../../capabilities/history-tools";

export interface RetainedArtifactReader {
  (taskId: string, originTaskId: string, artifactId: string): Promise<{
    artifact: { name: string; contentType: string; contentDigest: string }; content: Uint8Array;
  }>;
}

const terminal = "('completed','incomplete','refused','failed','cancelled','uncertain')";

/** Resolve only explicitly selected earlier conversation pages for a specialist brief. */
export async function readDelegationHistory(pool:Pool,taskId:string,raw:unknown,evidence:EvidenceStore,operationId:string) {
  const parsed = specialistHistoryReferenceSchema.array().max(8).safeParse(raw);
  if (!parsed.success) throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the selected history references");
  const references=parsed.data,execution=await scope(pool,taskId),task=execution.task;
  if (!references.length) return [];
  await evidence.recordDelegationHistory(taskId,operationId,references.map(reference=>reference.taskId));
  const pages=[];
  for (const reference of references) {
    const row=(await pool.query(`SELECT t.id,t.input,t.output FROM agents_platform.tasks t
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
      WHERE t.id=$1 AND t.organization_id=$2 AND t.conversation_id=$3 AND t.principal=$4::jsonb
        AND t.product=$5 AND t.caller_client_id=$6 AND t.resource_id=$7 AND t.turn_sequence<$8 AND t.state IN ${terminal}`,
    [reference.taskId,task.organization_id,task.conversation_id,JSON.stringify(task.principal),task.product,task.caller_client_id,task.resource_id,task.turn_sequence])).rows[0];
    const text=reference.part==="input"?row?.input:row?.output;
    if(typeof text!=="string")throw new PlatformError("HISTORY_UNAVAILABLE",404,"The selected history is unavailable");
    const bytes=Buffer.from(text),offset=reference.offset;
    if(offset>bytes.length||offset<bytes.length&&(bytes[offset]!&0xc0)===0x80)throw new PlatformError("HISTORY_RANGE_INVALID",400,"The history offset is invalid");
    const content=fitUtf8(bytes.subarray(offset).toString("utf8"),reference.maxBytes),end=offset+Buffer.byteLength(content);
    pages.push({taskId:row.id,part:reference.part,offset,nextOffset:end<bytes.length?end:null,totalBytes:bytes.length,
      complete:offset===0&&end===bytes.length,digest:requestDigest(text),content,trust:"reference_data" as const});
  }
  return pages;
}

/** Call only after the full public operation receipt has committed. */
export function toolReceiptPreview(operationId:string,name:string,output:unknown,modelContent:string){
  const retained=publicReceiptContent({operationId,name,state:"completed",output,errorCode:null});
  return {preview:fitUtf8(modelContent,4096),complete:false,read:{operationId,offset:0},totalBytes:Buffer.byteLength(retained),digest:requestDigest(retained),trust:"reference_data"};
}
function publicReceiptContent(receipt:{operationId:string;name:string;state:string;output:unknown;errorCode:string|null}):string{
  // Normalize exactly as JSONB custody does, including omitted optional properties.
  return canonicalJson(JSON.parse(JSON.stringify({...receipt,output:receipt.output===undefined?null:receipt.output})));
}
export function modelReceiptOutput(execution:Execution,row:{id:string;name:string;state:string;output:unknown;request?:{productBindingId?:string;bindingDigest?:string;arguments?:string}}):unknown {
  if(row.state!=="completed")return row.output;
  if(!row.request?.productBindingId){
    if(!row.request?.bindingDigest)return builtinObservationView(row.name,row.request?.arguments??"{}",row.output);
    const binding=execution.connectedBindings.find(value=>value.alias===row.name&&value.digest===row.request!.bindingDigest);
    const value=row.output as Partial<ConnectedObservation>|null;
    if(!binding||!value||typeof value.content!=="string"||typeof value.truncated!=="boolean"||
      !["ok","tool_error"].includes(value.status??"")||!value.evidence||typeof value.evidence.id!=="string"||
      typeof value.evidence.citation!=="string"||!value.observation||typeof value.observation.acquiredAt!=="string")
      throw new PlatformError("EVIDENCE_INTEGRITY",409,"The connected result is unavailable");
    return connectedModelView(value as ConnectedObservation);
  }
  const binding=execution.configuration.productBindings.find(value=>value.id===row.request!.productBindingId&&value.digest===row.request!.bindingDigest);
  if(!binding)throw new PlatformError("EVIDENCE_INTEGRITY",409,"The product result is unavailable");
  return productModelResult(binding,row.output,execution.task.id,row.id);
}
export async function modelReceiptOutputWithReferences(pool:Pool,taskId:string,execution:Execution,row:{id:string;name:string;state:string;output:unknown;error_code?:string|null;request?:{productBindingId?:string;bindingDigest?:string;arguments?:string}}):Promise<unknown>{
  if(row.state!=="completed")return row.request?.productBindingId?{state:row.state,errorCode:row.error_code??"PRODUCT_OPERATION_FAILED"}:row.output;
  const projected=modelReceiptOutput(execution,row);
  if(!row.request?.productBindingId)return projected;
  const binding=execution.configuration.productBindings.find(value=>value.id===row.request!.productBindingId&&value.digest===row.request!.bindingDigest);
  if(!binding)throw new PlatformError("EVIDENCE_INTEGRITY",409,"The product result is unavailable");
  return projectProductReferences(pool,taskId,row.id,binding,projected);
}

async function scope(pool: Pool, taskId: string) {
  const execution = await loadExecution(pool, taskId);
  await assertCurrentAuthority(pool, execution);
  // Customer histories are supplied by the channel's canonical message journal.
  if (execution.task.channel_binding) throw new PlatformError("HISTORY_SCOPE_DENIED", 403, "This history source is unavailable");
  return execution;
}

async function searchArtifacts(pool:Pool,taskId:string,input:ReturnType<typeof historySearchInputSchema.parse>,evidence:EvidenceStore,operationId:string){
  const execution=await scope(pool,taskId),task=execution.task;
  const grant=(await pool.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[task.grant_id])).rows[0];
  if(!["human","automation"].includes(task.principal.kind)||!grant?.operations.includes("artifact.read"))throw new PlatformError("HISTORY_SCOPE_DENIED",403,"Artifact history is unavailable");
  const artifacts=new TaskArtifactStore(pool),parameters=[task.organization_id,task.conversation_id,JSON.stringify(task.principal),task.product,task.caller_client_id,task.resource_id,task.turn_sequence,taskId,execution.agentId];
  const candidates=`SELECT DISTINCT ON(a.id) a.id,a.created_at,a.created_at::text AS cursor_time,origin.id AS origin_task_id,origin.turn_sequence::text AS sequence
    FROM agents_platform.tasks origin JOIN agents_platform.conversations c ON c.id=origin.conversation_id AND c.deleted_at IS NULL
    JOIN agents_platform.agent_versions v ON v.id=origin.version_id AND v.organization_id=origin.organization_id AND v.agent_id=$9
    JOIN agents_platform.artifacts a ON a.root_task_id=origin.root_task_id AND a.organization_id=origin.organization_id AND a.state='available'
    WHERE origin.organization_id=$1 AND origin.conversation_id=$2 AND origin.principal=$3::jsonb AND origin.product=$4
    AND origin.caller_client_id=$5 AND origin.resource_id=$6 AND (origin.id=$8 OR origin.turn_sequence<$7 AND origin.state IN ${terminal})
    AND (a.task_id=origin.id OR origin.id=origin.root_task_id OR EXISTS(SELECT 1 FROM agents_platform.task_artifact_transfers x WHERE x.artifact_id=a.id AND x.target_task_id=origin.id))
    ORDER BY a.id,origin.turn_sequence DESC`;
  const cursor=input.beforeArtifactId?(await pool.query(`SELECT * FROM (${candidates}) candidates WHERE id=$10`,[...parameters,input.beforeArtifactId])).rows[0]:undefined;
  if(input.beforeArtifactId){
    if(!cursor)throw new PlatformError("HISTORY_UNAVAILABLE",404,"The artifact cursor is unavailable");
    await artifacts.inspectHistoryArtifact(taskId,cursor.origin_task_id,cursor.id);
  }
  const results:HistoryResult[]=[],selected:{originTaskId:string;artifactId:string;manifest:DependencyManifest}[]=[];
  const terms=input.query?.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
  let last:string|null=cursor?.id??null,beforeTime:string|null=cursor?.cursor_time??null,exhausted=false;
  while(results.length<input.limit&&!exhausted){
    const rows=(await pool.query(`SELECT * FROM (${candidates}) candidates
      WHERE ($10::timestamptz IS NULL OR (created_at,id)<($10::timestamptz,$11::uuid))
      AND ($12::timestamptz IS NULL OR created_at >= $12) AND ($13::timestamptz IS NULL OR created_at < $13)
      ORDER BY created_at DESC,id DESC LIMIT 64`,[...parameters,beforeTime,last,input.since??null,input.before??null])).rows;
    if(!rows.length){exhausted=true;break;}
    for(const row of rows){
      last=row.id;beforeTime=row.cursor_time;
      let inspected:Awaited<ReturnType<TaskArtifactStore["inspectHistoryArtifact"]>>;
      try{inspected=await artifacts.inspectHistoryArtifact(taskId,row.origin_task_id,row.id);}
      catch(error){if(error instanceof PlatformError&&[403,404,409].includes(error.statusCode))continue;throw error;}
      const artifact=inspected.artifact,metadata={name:artifact.name,contentType:artifact.contentType,bytes:artifact.bytes,contentDigest:artifact.contentDigest};
      const searchable=`${metadata.name} ${metadata.contentType}`.normalize("NFKC").toLocaleLowerCase();
      if(terms.length&&!terms.some(term=>searchable.includes(term)))continue;
      results.push({taskId:row.origin_task_id,sequence:row.sequence,artifactId:artifact.id,artifact:metadata,metadataOnly:true,
        createdAt:new Date(row.created_at).toISOString(),preview:fitUtf8(canonicalJson(metadata),512),complete:false,digest:artifact.contentDigest});
      selected.push({originTaskId:row.origin_task_id,artifactId:artifact.id,manifest:inspected.manifest});
      if(results.length===input.limit)break;
    }
    if(rows.length<64&&results.length<input.limit)exhausted=true;
  }
  await evidence.retainArtifactMetadata(taskId,operationId,selected);
  return{results,nextBeforeSequence:null,nextBeforeArtifactId:exhausted?null:last,availability:"retained_authorized_records" as const,previews:true as const};
}

/** Task inputs, outputs and operation receipts are the retained journal. No second transcript owns them. */
export async function searchHistory(pool: Pool, taskId: string, raw: unknown, evidence: EvidenceStore, operationId: string) {
  const parsed = historySearchInputSchema.safeParse(raw);
  if (!parsed.success) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check the history search");
  const input = parsed.data, execution = await scope(pool, taskId), task = execution.task;
  if(input.part==="artifacts")return searchArtifacts(pool,taskId,input,evidence,operationId);
  if(input.part==="operations"){
    await assertCurrentEvidence(pool,taskId,await evidence.taskManifest(taskId));
    const cursor=input.beforeOperationId?(await pool.query("SELECT started_at::text AS cursor_time,id FROM agents_platform.operations WHERE id=$1 AND task_id=$2",[input.beforeOperationId,taskId])).rows[0]:undefined;
    if(input.beforeOperationId&&!cursor)throw new PlatformError("HISTORY_UNAVAILABLE",404,"The receipt cursor is unavailable");
    const results:HistoryResult[]=[];let last:string|null=cursor?.id??null,beforeTime=cursor?.cursor_time??null,exhausted=false;
    while(results.length<input.limit&&!exhausted){
      const rows=(await pool.query(`SELECT id,name,state,output,request,error_code,started_at,started_at::text AS cursor_time FROM agents_platform.operations
        WHERE task_id=$1 AND kind IN ('tool','delegation','resource') AND state IN ('completed','failed','uncertain')
        AND name NOT IN ('history.search','history.read') AND ($2::timestamptz IS NULL OR (started_at,id)<($2::timestamptz,$3::text))
        AND ($4::timestamptz IS NULL OR started_at >= $4) AND ($5::timestamptz IS NULL OR started_at < $5)
        ORDER BY started_at DESC,id DESC LIMIT 64`,[taskId,beforeTime,last,input.since??null,input.before??null])).rows;
      if(!rows.length){exhausted=true;break;}
      for(const row of rows){
        last=row.id;beforeTime=row.cursor_time;
        try{await evidence.validateOperation(taskId,row.id);}
        catch(error){if(error instanceof PlatformError&&[403,404,409].includes(error.statusCode))continue;throw error;}
        const content=publicReceiptContent({operationId:row.id,name:row.name,state:row.state,output:await modelReceiptOutputWithReferences(pool,taskId,execution,row),errorCode:row.error_code});
        const terms=input.query?.toLocaleLowerCase().split(/\s+/u).filter(Boolean)??[];
        if(terms.some(term=>!content.toLocaleLowerCase().includes(term)))continue;
        await evidence.retainOperation(taskId,row.id);
        results.push({taskId,sequence:task.turn_sequence,operationId:row.id,name:row.name,state:row.state,createdAt:new Date(row.started_at).toISOString(),preview:fitUtf8(content,512),complete:false,digest:requestDigest(content)});
        if(results.length===input.limit)break;
      }
      if(rows.length<64&&results.length<input.limit)exhausted=true;
    }
    return {results,nextBeforeSequence:null,nextBeforeOperationId:exhausted?null:last,availability:"retained_authorized_records",previews:true};
  }
  let before = input.beforeSequence ?? task.turn_sequence;
  if (BigInt(before) > BigInt(task.turn_sequence)) before = task.turn_sequence;
  const results: HistoryResult[] = [];
  let exhausted = false;
  while (results.length < input.limit && !exhausted) {
    const rows = (await pool.query(`SELECT t.id,t.turn_sequence::text,t.input,t.output,t.state,t.created_at FROM agents_platform.tasks t
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
      WHERE t.organization_id=$1 AND t.conversation_id=$2 AND t.principal=$3::jsonb AND t.product=$4
      AND t.caller_client_id=$5 AND t.resource_id=$6 AND t.turn_sequence<$7 AND t.state IN ${terminal}
      AND ($8::timestamptz IS NULL OR t.created_at >= $8) AND ($9::timestamptz IS NULL OR t.created_at < $9)
      ORDER BY t.turn_sequence DESC LIMIT 64`, [task.organization_id, task.conversation_id, JSON.stringify(task.principal), task.product, task.caller_client_id, task.resource_id, before,input.since??null,input.before??null])).rows;
    if (!rows.length) { exhausted = true; break; }
    const eligible = new Set((await evidence.checkHistory(taskId, rows.map(row => row.id))).filter(row => row.eligible).map(row => row.taskId));
    for (const row of rows) {
      before = row.turn_sequence;
      if (!eligible.has(row.id)) continue;
      const instructions = (await pool.query("SELECT instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence", [row.id])).rows.map(value => value.instruction);
      const content = [row.input, ...instructions, row.output ?? `Task ended: ${row.state}`].join("\n\n");
      const terms = input.query?.toLocaleLowerCase().split(/\s+/u).filter(Boolean) ?? [];
      if (terms.length && !terms.every(term => content.toLocaleLowerCase().includes(term))) continue;
      const start = terms.length ? Math.max(0, content.toLocaleLowerCase().indexOf(terms[0]!) - 100) : 0;
      results.push({ taskId: row.id, sequence: row.turn_sequence, createdAt: new Date(row.created_at).toISOString(), preview: fitUtf8(content.slice(start), 512), complete: false, digest: requestDigest(content) });
      if (results.length === input.limit) break;
    }
    if (rows.length < 64 && results.length < input.limit) exhausted = true;
  }
  await evidence.recordHistoryRead(taskId,operationId,results.map(result=>result.taskId));
  return { results, nextBeforeSequence: exhausted ? null : before, availability: "retained_authorized_records", previews: true };
}

export async function readHistory(pool: Pool, taskId: string, raw: unknown, evidence: EvidenceStore, operationId: string, readArtifact?: RetainedArtifactReader) {
  const parsed = historyReadInputSchema.safeParse(raw);
  if (!parsed.success) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check the history reference");
  const input = parsed.data, execution = await scope(pool, taskId), task = execution.task;
  if (input.artifactId) {
    if (!readArtifact) throw new PlatformError("HISTORY_UNAVAILABLE", 503, "Artifact recovery is unavailable");
    const result = await readArtifact(taskId, input.taskId!, input.artifactId);
    let text: string;
    try { text = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(result.content); }
    catch { throw new PlatformError("ARTIFACT_ENCODING_UNAVAILABLE", 409, "The retained artifact is not supported text"); }
    const page = pageRecord(text, input.offset, { taskId: input.taskId!, part: "artifact" });
    const { name, contentType, contentDigest } = result.artifact;
    return { ...page, artifactId: input.artifactId, artifact: { name, contentType, contentDigest }, encoding: "utf8" as const, digest: contentDigest };
  }
  if(input.operationId){
    const receipt=(await pool.query(`SELECT id,name,state,output,request,error_code FROM agents_platform.operations WHERE id=$1 AND task_id=$2
      AND kind IN ('tool','delegation','resource') AND state IN ('completed','failed','uncertain') AND name NOT IN ('history.search','history.read')`,[input.operationId,taskId])).rows[0];
    if(!receipt)throw new PlatformError("HISTORY_UNAVAILABLE",404,"The retained receipt is unavailable");
    await evidence.retainOperation(taskId,receipt.id);
    const projected=await modelReceiptOutputWithReferences(pool,taskId,execution,receipt);
    const content=publicReceiptContent({operationId:receipt.id,name:receipt.name,state:receipt.state,output:projected,errorCode:receipt.error_code});
    const changed=receipt.state==="completed"&&!receipt.request?.productBindingId&&requestDigest(projected??null)!==requestDigest(receipt.output??null);
    if(!changed)return pageRecord(content,input.offset,{taskId,operationId:receipt.id,part:"operations"});
    // Older accepted tasks may have a preview of the raw receipt. Its byte offsets
    // and digest do not describe this projected view; never substitute raw output.
    const bytes=Buffer.from(content),validOffset=input.offset<=bytes.length&&(input.offset===bytes.length||(bytes[input.offset]!&0xc0)!==0x80);
    return {...pageRecord(content,validOffset?input.offset:0,{taskId,operationId:receipt.id,part:"operations"}),
      projectionNotice:"This authorized view may differ from an earlier preview. When resuming an older preview, start at offset 0 and use this view's digest and offsets."};
  }
  const row = (await pool.query(`SELECT t.id,t.input,t.output,t.state FROM agents_platform.tasks t
    JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
    WHERE t.id=$1 AND t.organization_id=$2 AND t.conversation_id=$3 AND t.principal=$4::jsonb
    AND t.product=$5 AND t.caller_client_id=$6 AND t.resource_id=$7 AND t.turn_sequence<$8 AND t.state IN ${terminal}`,
  [input.taskId, task.organization_id, task.conversation_id, JSON.stringify(task.principal), task.product, task.caller_client_id, task.resource_id, task.turn_sequence])).rows[0];
  if (!row || !(await evidence.checkHistory(taskId, [row.id]))[0]?.eligible) throw new PlatformError("HISTORY_UNAVAILABLE", 404, "The retained record is unavailable");
  let content: string;
  if (input.part === "operations") {
    // Private provider continuation and reasoning are never part of this public journal.
    const operations = (await pool.query(`SELECT id,name,kind,state,output,request,error_code FROM agents_platform.operations
      WHERE task_id=$1 AND kind IN ('tool','delegation','resource') AND state IN ('completed','failed','uncertain')
        AND name NOT IN ('history.search','history.read') ORDER BY started_at,id`, [row.id])).rows;
    const origin=await loadExecution(pool,row.id),projected=[];
    for(const receipt of operations){
      await evidence.retainOperation(taskId,receipt.id,row.id);
      const {request:_request,...publicReceipt}=receipt;
      projected.push({...publicReceipt,output:await modelReceiptOutputWithReferences(pool,row.id,origin,receipt)});
    }
    content = JSON.stringify(projected);
  } else {
    const directions = (await pool.query("SELECT instruction FROM agents_platform.orchestration_instructions WHERE task_id=$1 ORDER BY sequence", [row.id])).rows;
    content = JSON.stringify([{ role: "user", content: row.input }, ...directions.map(value => ({ role: "user", content: value.instruction })), { role: "assistant", content: row.output ?? `Task ended: ${row.state}` }]);
  }
  await evidence.recordHistoryRead(taskId,operationId,[row.id]);
  return pageRecord(content,input.offset,{taskId:row.id,part:input.part});
}

function pageRecord(content:string,offset:number,identity:{taskId:string;operationId?:string;part:string}){
  const bytes = Buffer.from(content);
  if (offset > bytes.length || offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) throw new PlatformError("HISTORY_RANGE_INVALID", 400, "The history offset is invalid");
  const text = fitUtf8(bytes.subarray(offset).toString("utf8"), 4096), end = offset + Buffer.byteLength(text);
  return { ...identity, content: text, offset, nextOffset: end < bytes.length ? end : null, totalBytes: bytes.length, digest: requestDigest(content), complete: end === bytes.length, availability: "available", trust: "reference_data" };
}
