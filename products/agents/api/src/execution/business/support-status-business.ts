import * as restate from '@restatedev/restate-sdk';
import { restateServiceName } from '../../contracts/restate-names';
import type { Pool } from 'pg';
import { z } from 'zod';
import { supportStatusV2 } from '../../capabilities/support-status-v2';
import { PlatformError,requestDigest } from '../../contracts/contracts';
import type { TaskOutcome } from '../../contracts/execution';
import { transaction } from '../../infrastructure/database';
import { assertPendingSupportStatusAuthority } from '../lifecycle/authority';
import { loadExecution,settleTask } from '../lifecycle/execution';
import { invokeObservedTaskModel } from '../models/observed-invocation';
import { accountedModelTokens,operation,type BusinessOptions } from './business';
import { estimateRequestTokens,type ModelResponse } from './model';
import { supportStatusRequestForEpisode } from './support-status-request';

export const SUPPORT_STATUS_WORKFLOW = 'AgentsSupportStatusV23';
const statusAnswer = z.strictObject({reply:z.string().trim().min(1).max(1000).nullable()});

/** Runs one tool-free turn over the visitor's message and verified support facts. */
export function createSupportStatusWorkflow(pool:Pool,options:BusinessOptions & {publishSupportStatus:(taskId:string)=>Promise<boolean>}) {
  return restate.workflow({name:restateServiceName(SUPPORT_STATUS_WORKFLOW),handlers:{run:async(ctx:restate.WorkflowContext,input:{taskId:string}):Promise<TaskOutcome>=>{
    if(ctx.key!==input.taskId)throw new restate.TerminalError('Task identity mismatch',{errorCode:400});
    const taskId=input.taskId;
    await ctx.run('bind-status-invocation',async()=>{
      const bound=await pool.query(`UPDATE agents_platform.tasks SET runtime_invocation_id=$2 WHERE id=$1 AND execution_purpose='support_status_v1'
        AND (runtime_invocation_id IS NULL OR runtime_invocation_id=$2)`,[taskId,ctx.request().id]);
      if(!bound.rowCount)throw new restate.TerminalError('Status purpose unavailable',{errorCode:409});
    });
    let outcome:TaskOutcome={state:'incomplete',errorCode:'SUPPORT_STATUS_UNAVAILABLE'};
    try {
      const snapshot=await ctx.run('status-facts',()=>transaction(pool,async db=>{
        const execution=await loadExecution(db,taskId,true);
        await assertPendingSupportStatusAuthority(db,execution);
        const facts=await supportStatusV2(db,execution.task.organization_id,execution.configuration.supportHours);
        return {execution,facts,request:await supportStatusRequestForEpisode(db,execution,facts)};
      }));
      const {execution,facts,request}=snapshot,policy=execution.models.primary.policy;
      const estimated=estimateRequestTokens(request),reservedTokens=estimated+policy.safetyTokens+policy.maxOutputTokens;
      if(estimated+policy.safetyTokens>policy.maxInputTokens)throw new PlatformError('CONTEXT_LIMIT',413,'Support status is unavailable');
      const id=`support-status:${taskId}`;
      const result=await operation<ModelResponse>(ctx,pool,taskId,{id,kind:'model',name:'model.support_status',request:{modelRequest:request,supportFacts:facts},reservedTokens,reservedMs:policy.maxCallDurationMs},async()=>{
        const value=await invokeObservedTaskModel({pool,providerStore:options.modelProvider,execution,operationId:id,role:'primary',messages:request.messages,
          maxRequestBytes:policy.maxRequestBytes,signal:options.signal?AbortSignal.any([options.signal,ctx.request().attemptCompletedSignal]):ctx.request().attemptCompletedSignal},
          {...options.modelRuntime,assertAuthority:async db=>{const current=await loadExecution(db,taskId,true);await assertPendingSupportStatusAuthority(db,current);
            if(requestDigest(await supportStatusV2(db,current.task.organization_id,current.configuration.supportHours))!==requestDigest(facts))throw new PlatformError('SUPPORT_STATUS_CHANGED',409,'Support status changed');}});
        return {value,tokens:accountedModelTokens(value,reservedTokens)};
      });
      if(result.ok && result.value.finishReason==='stop' && result.value.message.content) {
        let parsed:unknown;try{parsed=JSON.parse(result.value.message.content);}catch{parsed=null;}
        const answer=statusAnswer.safeParse(parsed);
        if(answer.success && answer.data.reply)await ctx.run('publish-support-status',()=>options.publishSupportStatus(taskId));
        if(answer.success)outcome={state:'completed'};
      }
    } catch(error) {
      if(error instanceof restate.CancelledError){await ctx.run('settle-status-cancellation',()=>settleTask(pool,taskId,{state:'cancelled'}));throw error;}
      if(!(error instanceof PlatformError))throw error;
      outcome={state:'incomplete',errorCode:error.code};
    }
    await ctx.run('settle-status-task',()=>settleTask(pool,taskId,outcome));return outcome;
  }}});
}
