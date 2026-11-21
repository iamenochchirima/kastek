import type { Pool } from "pg";
import type { GrowthAgentObservation, GrowthAgentRuntimeOperation, GrowthAgentTask } from "@kasitek-labs/contracts";
import { PlatformError } from "../../contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence-policy";
import { pageQuery, readPageCursor, finishPage, nextPageCursor } from "../../infrastructure/read-pages";
import { readGrowthRuntime, projectGrowthRuntime,productOperationMetadataSql } from "./growth-runtime-reporting";
import { readPublicAgentUpdates } from "./public-agent-activity";
import { projectRecipientText, taskRecipientTextScope } from "../../execution/context/recipient-text";
import { TaskArtifactStore } from "../../execution/artifacts/task-artifacts";

type ObservationCommand = { requestId: string; tenantId: string; actor: { issuer: string; subject: string };
  input: { taskId: string; childTaskId?: string; cursor?: string; operationCursor?: string; limit?: number } };
interface GrowthObservationReader {
  pool: Pool;
  task(command: ObservationCommand, id: string): Promise<Record<string, any>>;
  taskDto(row: Record<string, any>): Promise<GrowthAgentTask>;
  principal(command: ObservationCommand): { kind: "human"; issuer: string; subject: string };
  runtime?: { authorizeTask(id: string): Promise<unknown> };
}

const iso = (value: Date|string) => new Date(value).toISOString();
const state = (value: string): GrowthAgentTask["state"] => ["running","waiting_children","reconciling"].includes(value) ? "working" : value as GrowthAgentTask["state"];
const missing = () => new PlatformError("NOT_FOUND",404,"Agent activity is unavailable");

export async function readProductChildren(pool:Pool,parent:{id:string;organization_id:string;principal:unknown},product:"growth"|"agencies"="growth"):Promise<NonNullable<GrowthAgentTask["children"]>> {
  const rows=(await pool.query(`SELECT t.id,a.name,t.state,t.error_code,t.input,t.created_at FROM agents_platform.tasks t
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=t.organization_id
    JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
    WHERE t.parent_task_id=$1 AND t.organization_id=$2 AND t.product=$3 AND t.principal=$4::jsonb ORDER BY t.created_at,t.id`,
  [parent.id,parent.organization_id,product,JSON.stringify(parent.principal)])).rows;
  const children:NonNullable<GrowthAgentTask["children"]>=[];
  for(const child of rows)try {
    await assertCurrentEvidence(pool,child.id,await taskEvidenceManifest(pool,child.id),{requireActiveTask:false});
    const assignment=typeof child.input==="string"?child.input.slice(0,4000):"";
    children.push({id:child.id,name:child.name,state:state(child.state),errorCode:child.error_code,createdAt:iso(child.created_at),assignment:projectRecipientText(assignment,await taskRecipientTextScope(pool,child.id,[assignment]))});
  } catch(error){if(!(error instanceof PlatformError)||![403,404,409,503].includes(error.statusCode))throw error;}
  return children;
}

async function operationPage(pool: Pool, row: Record<string,any>, command: ObservationCommand,product="growth",clientId?:string) {
  const scope={kind:`${product}-public-operations`,tenant:command.tenantId,actor:command.actor,root:command.input.taskId,task:row.id,...(clientId?{clientId}:{})};
  const page=pageQuery.parse({limit:command.input.limit,cursor:command.input.operationCursor}),cursor=readPageCursor(page.cursor,scope);
  if(cursor.position&&!Number.isFinite(Date.parse(cursor.position)))throw new PlatformError("INVALID_CURSOR",400,"Invalid operation cursor");
  const rows=(await pool.query(`SELECT o.id,md5(o.id) AS cursor_id,to_char(o.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_position,o.task_id,o.kind,
    ${productOperationMetadataSql},
    o.state,o.started_at,o.completed_at,o.error_code FROM agents_platform.operations o
    JOIN agents_platform.tasks t ON t.id=o.task_id JOIN agents_platform.agent_versions v ON v.id=t.version_id
    WHERE o.task_id=$1 AND o.started_at<=$2 AND ($3::text='' OR (o.started_at,md5(o.id))<($3::timestamptz,$4::text))
    ORDER BY o.started_at DESC,md5(o.id) DESC LIMIT $5`,[row.id,cursor.snapshot,cursor.position,cursor.id,Math.min(page.limit,60)+1])).rows;
  const result=finishPage(rows,Math.min(page.limit,60),scope,cursor.snapshot,item=>({position:item.cursor_position,id:item.cursor_id}));
  const operations: GrowthAgentRuntimeOperation[]=projectGrowthRuntime(row as never,{tasks:[{id:row.id,name:row.agent_name,tokens_used:row.tokens_used,model_calls:row.model_calls,tool_calls:row.tool_calls}],operations:result.items,aggregate:{}}).operations;
  return {operations,nextOperationCursor:result.nextCursor};
}

/** A root-authorized projection, never an evaluation export or a browser-authorized child lookup. */
export async function observeProductTask(service: GrowthObservationReader, command: ObservationCommand,options:{product?:"growth"|"agencies";clientId?:string}={}): Promise<GrowthAgentObservation> {
  const product=options.product??"growth";
  const root=await service.task(command,command.input.taskId),pool=service.pool;
  let row=root;
  if(command.input.childTaskId && command.input.childTaskId!==root.id) {
    row=(await pool.query(`WITH RECURSIVE lineage AS (
      SELECT t.id,t.parent_task_id,ARRAY[t.id] AS path FROM agents_platform.tasks t
        WHERE t.id=$2 AND t.root_task_id=$1 AND t.organization_id=$3 AND t.principal=$4::jsonb AND t.product=$6
      UNION ALL SELECT t.id,t.parent_task_id,l.path||t.id FROM agents_platform.tasks t JOIN lineage l ON t.id=l.parent_task_id
        JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
        WHERE t.root_task_id=$1 AND t.organization_id=$3 AND t.principal=$4::jsonb AND t.product=$6 AND NOT t.id=ANY(l.path)
    ) SELECT t.*,a.name AS agent_name,f.feature_id FROM agents_platform.tasks t
      JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
      JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=t.organization_id
      JOIN agents_platform.product_execution_features f ON f.agent_id=a.id AND f.tenant_id=$5 AND f.product=$6 AND f.enabled
      WHERE t.id=$2 AND EXISTS(SELECT 1 FROM lineage WHERE id=$1)`,[root.id,command.input.childTaskId,root.organization_id,JSON.stringify(service.principal(command)),command.tenantId,product])).rows[0];
    if(!row)throw missing();
    await service.runtime!.authorizeTask(row.id);
  }
  const withdrawn=():GrowthAgentObservation=>({rootTaskId:root.id,parentTaskId:row.parent_task_id??null,agentName:row.agent_name??"Agent",
    task:{id:row.id,conversationId:row.conversation_id,featureId:row.feature_id,state:state(row.state),
      input:row.id===root.id?row.input:"",output:null,errorCode:"EVIDENCE_UNAVAILABLE",observedAt:new Date().toISOString(),
      createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),updates:[],updatesTruncated:false,children:[],sources:[],results:[],reviewIds:[]},
    events:[],nextCursor:null,operations:[],nextOperationCursor:null,updates:[],updatesTruncated:false});
  // Product/actor authority above must succeed. Policy failures hide derived content while allowing a later authorized observation to restore it.
  try {await assertCurrentEvidence(pool,row.id,await taskEvidenceManifest(pool,row.id),{requireActiveTask:false});}
  catch(error){if(error instanceof PlatformError&&[403,404,409,503].includes(error.statusCode))return withdrawn();throw error;}
  const agentName=row.agent_name??(await pool.query(`SELECT a.name FROM agents_platform.agent_versions v JOIN agents_platform.agents a ON a.id=v.agent_id WHERE v.id=$1`,[row.version_id])).rows[0]?.name??"Agent";
  let childResults:NonNullable<GrowthAgentTask["results"]>=[];
  if(row.id!==root.id&&(await pool.query("SELECT 1 FROM agents_platform.artifacts WHERE task_id=$1 AND root_task_id=$2 AND state='available' LIMIT 1",[row.id,root.id])).rowCount){
    try{childResults=(await new TaskArtifactStore(pool).listForChild(root.id,row.id)).map(artifact=>({id:artifact.id,kind:"artifact" as const,title:artifact.name,artifactId:artifact.id}));}
    catch(error){if(error instanceof PlatformError&&[403,404,409,503].includes(error.statusCode))return withdrawn();throw error;}
  }
  const task:GrowthAgentTask = row.id===root.id ? await service.taskDto(root) : {
    observedAt:new Date().toISOString(),id:row.id,conversationId:row.conversation_id,featureId:row.feature_id,
    state:state(row.state),input:typeof row.input==="string"?projectRecipientText(row.input,await taskRecipientTextScope(pool,row.id,[row.input])):row.input,output:typeof row.output==="string"?projectRecipientText(row.output,await taskRecipientTextScope(pool,row.id,[row.output])):row.output,errorCode:row.error_code,
    createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),runtime:await readGrowthRuntime(pool,row as never,product),
    canSteer:false,canContinue:false,sources:[],results:childResults,children:await readProductChildren(pool,row as never,product),
  };
  if(task.errorCode==="EVIDENCE_UNAVAILABLE")return withdrawn();
  const scope={kind:`${product}-public-events`,tenant:command.tenantId,actor:command.actor,root:root.id,task:row.id,...(options.clientId?{clientId:options.clientId}:{})};
  const page=pageQuery.parse(command.input),cursor=readPageCursor(page.cursor,scope);
  if(cursor.position&&!/^[0-9]{1,19}$/.test(cursor.position))throw new PlatformError("INVALID_CURSOR",400,"Invalid event cursor");
  const events=(await pool.query(`SELECT sequence,kind,created_at FROM agents_platform.task_events WHERE task_id=$1 AND sequence>$2::bigint ORDER BY sequence LIMIT $3`,[row.id,cursor.position||"0",page.limit])).rows;
  const last=events.at(-1);
  return {task,rootTaskId:root.id,parentTaskId:row.parent_task_id??null,agentName,
    events:events.map(event=>({id:String(event.sequence),taskId:row.id,type:event.kind,createdAt:iso(event.created_at)})),
    nextCursor:last?nextPageCursor({snapshot:new Date().toISOString(),position:String(last.sequence),id:""},scope):page.cursor??null,
    ...await operationPage(pool,{...row,agent_name:agentName},command,product,options.clientId),...(task.updates?{updates:task.updates,updatesTruncated:task.updatesTruncated??false}:await readPublicAgentUpdates(pool,row.id))};
}
export { observeProductTask as observeGrowthTask };
