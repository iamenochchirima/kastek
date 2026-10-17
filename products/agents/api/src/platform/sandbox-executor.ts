import type { Pool } from "pg";
import { z } from "zod";
import type { PrivateObjectStore } from "./artifacts";
import { PlatformError } from "./contracts";
import { transaction } from "./database";
import { assertCurrentAuthority, loadExecution } from "./execution";
import type { SandboxManager } from "./sandbox";
import { TaskArtifactStore } from "./task-artifacts";
import { fitUtf8 } from "./tools";

const argumentsSchema=z.strictObject({code:z.string().min(1).max(16384),inputArtifactIds:z.array(z.uuid()).max(32).optional()});
export function createSandboxExecutor(pool:Pool,manager:SandboxManager|undefined,objects:PrivateObjectStore|undefined) {
  const artifacts=new TaskArtifactStore(pool,objects);
  return async (taskId:string,operationId:string,raw:{code:string;inputArtifactIds?:string[]})=>{
    if(!manager||!objects)throw new PlatformError("SANDBOX_UNAVAILABLE",503,"Analysis is unavailable");
    const args=argumentsSchema.parse(raw);
    const execution=await transaction(pool,async db=>{const value=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,value);return value;});
    if(!execution.configuration.capabilities.sandbox.enabled)throw new PlatformError("SANDBOX_SCOPE_DENIED",403,"Analysis is unavailable");
    const inputs=[];
    for(const id of args.inputArtifactIds??[]) {
      const value=await artifacts.readForTask(taskId,id);
      inputs.push({name:value.artifact.name,content:value.content});
    }
    const scope={organizationId:execution.task.organization_id,rootTaskId:execution.task.root_task_id,taskId,deadlineAt:new Date(execution.task.deadline_at)};
    const result=await manager.analyze(scope,{operationId,code:args.code,inputs});
    const diagnostics={stdout:fitUtf8(result.stdout,2048),stderr:fitUtf8(result.stderr,2048),
      diagnosticsTruncated:Buffer.byteLength(result.stdout)>2048||Buffer.byteLength(result.stderr)>2048};
    if(result.artifactRefs) return {allocationId:result.allocationId,commandId:result.commandId,state:result.state,exitCode:result.exitCode,
      ...diagnostics,errorCode:result.errorCode,artifacts:result.artifactRefs};
    const refs=[];
    for(const output of result.exports) {
      const artifact=await artifacts.put(taskId,operationId,{...output,sourceReferences:[
        ...execution.configuration.knowledgeIds.map(id=>({kind:"knowledge",id})),...(args.inputArtifactIds??[]).map(id=>({kind:"artifact",id}))]});
      refs.push({id:artifact.id,name:artifact.name,contentType:artifact.contentType,bytes:artifact.bytes,contentDigest:artifact.contentDigest,taskId,rootTaskId:artifact.rootTaskId});
    }
    await manager.finalize(scope,result.allocationId,refs);
    return {allocationId:result.allocationId,commandId:result.commandId,state:result.state,exitCode:result.exitCode,
      ...diagnostics,errorCode:result.errorCode,artifacts:refs};
  };
}
