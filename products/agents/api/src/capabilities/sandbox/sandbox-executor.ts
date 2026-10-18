import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { TaskArtifactStore } from "../../execution/artifacts/task-artifacts";
import { ModelOperationError } from "../../execution/business/model";
import { assertCurrentAuthority,loadExecution } from "../../execution/lifecycle/execution";
import { transaction } from "../../infrastructure/database";
import { PrivateObjectStore } from "../../infrastructure/object-store";
import { fitUtf8 } from "../tools";
import type { SandboxManager } from "./sandbox";

const argumentsSchema=z.strictObject({code:z.string().min(1).max(16384),inputArtifactIds:z.array(z.uuid()).max(32).optional()});
export function createSandboxExecutor(pool:Pool,manager:Pick<SandboxManager,"analyze"|"finalize">|undefined,objects:PrivateObjectStore|undefined) {
  const artifacts=new TaskArtifactStore(pool,objects);
  const execute=async (taskId:string,operationId:string,raw:{code:string;inputArtifactIds?:string[]},deadline:{expiresAt:number;expired:boolean})=>{
    const checkDeadline=()=>{if(deadline.expired||Date.now()>=deadline.expiresAt)throw new ModelOperationError("SANDBOX_OPERATION_TIMEOUT","uncertain");};
    if(!manager||!objects)throw new PlatformError("SANDBOX_UNAVAILABLE",503,"Analysis is unavailable");
    const args=argumentsSchema.parse(raw);
    const execution=await transaction(pool,async db=>{const value=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,value);return value;});
    checkDeadline();
    if(!execution.configuration.capabilities.sandbox.enabled)throw new PlatformError("SANDBOX_SCOPE_DENIED",403,"Analysis is unavailable");
    const inputs=[];
    for(const id of args.inputArtifactIds??[]) {
      checkDeadline();
      const value=await artifacts.readForTask(taskId,id);
      checkDeadline();
      inputs.push({name:value.artifact.name,content:value.content});
    }
    checkDeadline();
    const scope={organizationId:execution.task.organization_id,rootTaskId:execution.task.root_task_id,taskId,
      deadlineAt:new Date(Math.min(new Date(execution.task.deadline_at).getTime(),deadline.expiresAt-30_000))};
    const result=await manager.analyze(scope,{operationId,code:args.code,inputs});
    checkDeadline();
    const diagnostics={stdout:fitUtf8(result.stdout,2048),stderr:fitUtf8(result.stderr,2048),
      diagnosticsTruncated:Buffer.byteLength(result.stdout)>2048||Buffer.byteLength(result.stderr)>2048};
    if(result.artifactRefs) return {allocationId:result.allocationId,commandId:result.commandId,state:result.state,exitCode:result.exitCode,
      ...diagnostics,errorCode:result.errorCode,artifacts:result.artifactRefs};
    const refs=[];
    for(const output of result.exports) {
      checkDeadline();
      const artifact=await artifacts.put(taskId,operationId,{...output,sourceReferences:[
        ...(args.inputArtifactIds??[]).map(id=>({kind:"artifact",id}))]});
      checkDeadline();
      refs.push({id:artifact.id,name:artifact.name,contentType:artifact.contentType,bytes:artifact.bytes,contentDigest:artifact.contentDigest,taskId,rootTaskId:artifact.rootTaskId});
    }
    checkDeadline();await manager.finalize(scope,result.allocationId,refs);checkDeadline();
    return {allocationId:result.allocationId,commandId:result.commandId,state:result.state,exitCode:result.exitCode,
      ...diagnostics,errorCode:result.errorCode,artifacts:refs};
  };
  return async (taskId:string,operationId:string,raw:{code:string;inputArtifactIds?:string[]})=>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const deadline={expiresAt:Date.now()+240_000,expired:false};
    try {
      return await Promise.race([execute(taskId,operationId,raw,deadline),new Promise<never>((_resolve,reject)=>{
        timer=setTimeout(()=>{deadline.expired=true;reject(new ModelOperationError("SANDBOX_OPERATION_TIMEOUT","uncertain"));},240_000);
      })]);
    } finally { if(timer)clearTimeout(timer); }
  };
}
