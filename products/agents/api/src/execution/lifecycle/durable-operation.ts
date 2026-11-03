import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import { PlatformError } from "../../contracts/contracts";
import { ModelOperationError } from "../business/model";
import { event, beginOperation, beginHandoffFeedbackOperation, finishOperation, type OperationRequest } from "./execution";
import { persistOperationReceipt } from "../scheduling/receipt-persistence";
import type { CapacityDecision } from "../scheduling/capacity";
import { requestDigest } from "../../contracts/contracts";
export type Result<T> = {ok:true;value:T}|{ok:false;code:string;uncertain:boolean};
const unknownOperationCodes = new Set(["CONNECTED_READ_UNCERTAIN", "CONNECTED_OPERATION_UNCERTAIN", "BOOKING_OUTCOME_UNCERTAIN", "QUERY_RESOURCE_UNCERTAIN", "EXECUTION_OBJECT_UNCERTAIN", "PRODUCT_EFFECT_UNCERTAIN"]);
export function uncertainOperation(error:ModelOperationError|PlatformError):boolean {return error instanceof ModelOperationError ? error.outcome === "uncertain" : unknownOperationCodes.has(error.code);}

type JournaledOperation<T> = {result:Result<T>} | {waiting:Extract<CapacityDecision,{state:"waiting"}>} | {
  receipt:{attemptId:string;state:"completed"|"failed"|"uncertain";value:T|null;tokens:number;code:string|null}
};
export async function operation<T>(ctx: restate.WorkflowContext, pool: Pool, taskId: string, input: OperationRequest,
  perform: (recovering?:boolean) => Promise<{ value: T; tokens: number }>, journalName = input.id): Promise<Result<T>> {
  for(let capacityAttempt=0;capacityAttempt<256;capacityAttempt++) {
    const attemptName=capacityAttempt===0?journalName:`${journalName}:capacity:${capacityAttempt}`;
    const outcome:JournaledOperation<T> = await ctx.run(`${attemptName}:perform`, async () => {
      let attemptId:string|undefined;
      try {
        const admission = input.name === "model.handoff_feedback" ? await beginHandoffFeedbackOperation(pool,taskId,input) : await beginOperation(pool, taskId, input);
        if(admission.waiting)return {waiting:admission.capacity};
        if (admission.replayed) {
          if (admission.operation.state === "completed") return {result:{ok:true as const,value:admission.operation.output as T}};
          return {result:{ok:false as const,code:admission.operation.error_code??"OPERATION_OUTCOME_UNCERTAIN",uncertain:admission.operation.state==="uncertain"}};
        }
        attemptId=admission.operation.attempt_id;
        const result = await perform(admission.recovering);
        if(input.kind!=="delegation" && Date.now()-new Date(admission.operation.started_at).getTime()>input.reservedMs) throw new ModelOperationError("RESOURCE_TIME_BOUND_EXCEEDED","uncertain");
        if(input.maxResultBytes!==undefined && Buffer.byteLength(JSON.stringify(result.value))>input.maxResultBytes) throw new PlatformError("TOOL_RESULT_LIMIT",413,"Tool result exceeded its published bound");
        if (!Number.isSafeInteger(result.tokens) || result.tokens < 0) throw new ModelOperationError("MODEL_ACCOUNTING_INVALID", "uncertain");
        return {receipt:{attemptId,state:"completed" as const,value:result.value,tokens:result.tokens,code:null}};
      } catch (error) {
        if (!(error instanceof ModelOperationError) && !(error instanceof PlatformError)) throw error;
        if(error instanceof PlatformError&&error.code==="CONNECTED_READ_IN_PROGRESS")return {result:{ok:false as const,code:"CONNECTED_READ_IN_PROGRESS",uncertain:false}};
        const uncertain = uncertainOperation(error);
        if(attemptId)return {receipt:{attemptId,state:uncertain?"uncertain" as const:"failed" as const,value:null,tokens:uncertain?input.reservedTokens:0,code:error.code}};
        return {result:{ok:false as const,code:error.code,uncertain}};
      }
    });
    if('waiting' in outcome){
      if(input.name === "model.handoff_feedback" || input.name === "model.support_status") return {ok:false,code:"CAPACITY_UNAVAILABLE",uncertain:false};
      const remaining=new Date(outcome.waiting.deadline).getTime()-await ctx.date.now();
      if(remaining<=0)return{ok:false,code:"CAPACITY_WAIT_EXPIRED",uncertain:false};
      await restate.RestatePromise.race([ctx.promise(`capacity:${outcome.waiting.requestId}:${outcome.waiting.generation}`).get(),ctx.sleep(remaining)]);
      continue;
    }
    // The physical outcome is durable before native persistence can retry or lose its acknowledgement.
    const result:Result<T>='result' in outcome?outcome.result:await ctx.run(`${attemptName}:receipt`,async()=>{
      const expected=outcome.receipt;
      const receipt=await persistOperationReceipt(()=>finishOperation(pool,taskId,input.id,expected.state,expected.value,expected.code,expected.tokens,expected.attemptId));
      if(receipt.attempt_id!==expected.attemptId||receipt.state!==expected.state||receipt.accounted_tokens!==expected.tokens||receipt.error_code!==expected.code||requestDigest(receipt.output)!==requestDigest(expected.value))
        return {ok:false as const,code:receipt.error_code??"OPERATION_RECEIPT_CONFLICT",uncertain:receipt.state!=="failed"};
      return expected.state==="completed"?{ok:true as const,value:expected.value as T}:{ok:false as const,code:expected.code!,uncertain:expected.state==="uncertain"};
    });
    if(!result.ok&&result.code==="CONNECTED_READ_IN_PROGRESS"){await ctx.sleep(1000);continue;}
    return result;
  }
  return {ok:false,code:"CAPACITY_RETRY_LIMIT",uncertain:false};
}

