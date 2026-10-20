import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError,terminalTaskStates } from "../../contracts/contracts";
import { readChildResults,type DelegatedChild } from "../delegation/delegation";
import { assertCurrentAuthority,loadExecution,transaction } from "../lifecycle/execution";

const uuid = z.uuid();
const operationId = z.string().min(1).max(160).regex(/^[A-Za-z0-9:_-]+$/);
const state = z.enum(["completed","incomplete","refused","failed","cancelled","uncertain","running","accepted","waiting_authority","waiting_children","waiting_review"]);
export interface ContinuationEvidence { id:string; citation:string; operationId:string; kind:"source"|"connection"|"memory" }
export interface ContinuationCheckpoint {
  counts:{completed:number;failed:number;uncertain:number;delegations:number;artifacts:number};
  operations:{id:string;name:string;kind:"tool"|"delegation"|"resource";state:string}[];
  delegations:{operationId:string;children:{taskId:string;bindingId:string;state:string}[]}[];
  handles:{id:string;kind:"revision"|"file"|"release"}[];
  artifacts:{id:string}[];
  evidence:ContinuationEvidence[];
  omitted:{operations:number;delegations:number;handles:number;artifacts:number;evidence:number;results:number};
}
export interface ContinuationRecords {
  operations:ContinuationCheckpoint["operations"];delegations:ContinuationCheckpoint["delegations"];
  handles:ContinuationCheckpoint["handles"];artifacts:ContinuationCheckpoint["artifacts"];
  results:{taskId:string;output:string}[]; evidence?:ContinuationEvidence[]; evidenceOmitted?:number;
}
const integrity=()=>new PlatformError("CONTINUATION_INTEGRITY",409,"Execution continuation records are invalid");
export function buildContinuation(records:ContinuationRecords) {
  if(!Number.isSafeInteger(records.evidenceOmitted??0)||(records.evidenceOmitted??0)<0)throw integrity();
  for(const op of records.operations)if(!operationId.safeParse(op.id).success||!state.safeParse(op.state).success||!(["knowledge.search","knowledge.read","memory.search","memory.propose","skills.activate","skills.read","skills.run","agents.delegate","sandbox.analyze","report.prepare","report.deliver"].includes(op.name)||/^t_[a-f0-9]{32}$/.test(op.name))||!["tool","delegation","resource"].includes(op.kind))throw integrity();
  for(const group of records.delegations){if(!operationId.safeParse(group.operationId).success)throw integrity();for(const child of group.children)if(!uuid.safeParse(child.taskId).success||!/^[A-Za-z0-9_-]{1,64}$/.test(child.bindingId)||!state.safeParse(child.state).success)throw integrity();}
  for(const handle of records.handles)if(!uuid.safeParse(handle.id).success||!["revision","file","release"].includes(handle.kind))throw integrity();
  if(records.artifacts.some(item=>!uuid.safeParse(item.id).success)||records.results.some(item=>!uuid.safeParse(item.taskId).success))throw integrity();
  for(const item of records.evidence??[])if(!uuid.safeParse(item.id).success||!/^\[E[a-f0-9]{32}\]$/.test(item.citation)||!operationId.safeParse(item.operationId).success||!["source","connection","memory"].includes(item.kind))throw integrity();
  const checkpoint:ContinuationCheckpoint={counts:{completed:records.operations.filter(op=>op.state==="completed").length,failed:records.operations.filter(op=>op.state==="failed").length,uncertain:records.operations.filter(op=>op.state==="uncertain").length,delegations:records.delegations.length,artifacts:records.artifacts.length},operations:records.operations.slice(-6),delegations:records.delegations.slice(-4),handles:records.handles.slice(-6),artifacts:records.artifacts.slice(-2),evidence:(records.evidence??[]).slice(-8),omitted:{operations:Math.max(0,records.operations.length-6),delegations:Math.max(0,records.delegations.length-4),handles:Math.max(0,records.handles.length-6),artifacts:Math.max(0,records.artifacts.length-2),evidence:(records.evidenceOmitted??0)+Math.max(0,(records.evidence?.length??0)-8),results:0}};
  while(Buffer.byteLength(JSON.stringify(checkpoint))>3072){
    if(checkpoint.operations.length){checkpoint.operations.shift();checkpoint.omitted.operations++;}
    else if(checkpoint.handles.length){checkpoint.handles.shift();checkpoint.omitted.handles++;}
    else if(checkpoint.evidence.length){checkpoint.evidence.shift();checkpoint.omitted.evidence++;}
    else if(checkpoint.delegations.length){checkpoint.delegations.shift();checkpoint.omitted.delegations++;}
    else throw integrity();
  }
  const results:ContinuationRecords["results"]=[];
  for(const result of records.results.slice(-2)){if(Buffer.byteLength(result.output)<=1536&&Buffer.byteLength(JSON.stringify([...results,result]))<=2048)results.push(result);else checkpoint.omitted.results++;}
  checkpoint.omitted.results+=Math.max(0,records.results.length-2);
  return {checkpoint,results};
}

export async function loadContinuation(pool:Pool,taskId:string,includeResults:boolean,evidence:ContinuationEvidence[]=[],evidenceOmitted=0) {
  const records=await transaction(pool,async db=>{
    const execution=await loadExecution(db,taskId);await assertCurrentAuthority(db,execution);
    const operations=(await db.query("SELECT id,name,kind,state FROM agents_platform.operations WHERE task_id=$1 AND kind IN ('tool','delegation','resource') AND state IN ('completed','failed','uncertain') AND id NOT LIKE 'knowledge:%:initial' ORDER BY started_at,id",[taskId])).rows;
    const delegated=(await db.query(`SELECT d.operation_id,d.slot,d.binding_id,t.id AS task_id,t.version_id,t.state FROM agents_platform.delegations d
      JOIN agents_platform.operations o ON o.id=d.operation_id AND o.task_id=d.parent_task_id AND o.state='completed' AND o.kind='delegation'
      JOIN agents_platform.tasks t ON t.id=d.child_task_id AND t.parent_task_id=d.parent_task_id
      WHERE d.parent_task_id=$1 AND t.organization_id=$2 ORDER BY o.started_at,d.slot`,[taskId,execution.task.organization_id])).rows;
    const handles=(await db.query(`SELECT h.id,h.kind FROM agents_platform.connected_handles h JOIN agents_platform.connected_reads r ON r.operation_id=h.created_by_operation
      JOIN agents_platform.operations o ON o.id=r.operation_id WHERE r.task_id=$1 AND r.state='completed' AND o.state='completed' AND h.organization_id=$2 AND h.root_task_id=$3 ORDER BY o.started_at,h.id`,[taskId,execution.task.organization_id,execution.task.root_task_id])).rows;
    const artifacts=(await db.query("SELECT a.id FROM agents_platform.artifacts a JOIN agents_platform.execution_grants g ON g.id=$3 WHERE a.task_id=$1 AND a.organization_id=$2 AND a.state='available' AND g.operations ? 'artifact.read' ORDER BY a.created_at,a.id",[taskId,execution.task.organization_id,execution.task.grant_id])).rows;
    return{operations,delegated,handles,artifacts};
  });
  const groups=new Map<string,typeof records.delegated>();for(const child of records.delegated){const group=groups.get(child.operation_id)??[];group.push(child);groups.set(child.operation_id,group);}
  const delegations:ContinuationRecords["delegations"]=[],results:ContinuationRecords["results"]=[];
  for(const [id,children]of groups){
    const references:DelegatedChild[]=children.map(child=>({taskId:child.task_id,bindingId:child.binding_id,versionId:child.version_id,slot:child.slot}));
    if(children.every(child=>terminalTaskStates.has(child.state))){
      const checked=await readChildResults(pool,taskId,references);
      if(includeResults)for(const child of checked.children)if(child.output)results.push({taskId:child.taskId,output:child.output});
    }
    delegations.push({operationId:id,children:children.map(child=>({taskId:child.task_id,bindingId:child.binding_id,state:child.state}))});
  }
  return buildContinuation({operations:records.operations,delegations,handles:records.handles,artifacts:records.artifacts,results,evidence,evidenceOmitted});
}
