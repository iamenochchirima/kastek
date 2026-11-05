import {beforeEach,describe,expect,it,vi} from "vitest";
import type {Pool} from "pg";
import * as restate from "@restatedev/restate-sdk";
import {PlatformError} from "../src/contracts/contracts";
import {operation} from "../src/execution/lifecycle/durable-operation";
import {beginOperation,finishOperation} from "../src/execution/lifecycle/execution";

vi.mock("../src/execution/lifecycle/execution",async original=>({
 ...await original<typeof import("../src/execution/lifecycle/execution")>(),
 beginOperation:vi.fn(),finishOperation:vi.fn(),
}));
const input={id:"op",kind:"tool" as const,name:"some.write",request:{},reservedTokens:5,reservedMs:10000};
const pool={} as Pool;
const ctx={run:async (_name:string,fn:()=>Promise<unknown>)=>fn()} as unknown as restate.WorkflowContext;
beforeEach(()=>{
 vi.resetAllMocks();
 vi.mocked(beginOperation).mockResolvedValue({replayed:false,operation:{attempt_id:"attempt",started_at:new Date()}} as never);
 vi.mocked(finishOperation).mockImplementation(async(_pool,_task,_id,state,output,code,tokens,attemptId)=>({attempt_id:attemptId,state,output,error_code:code,accounted_tokens:tokens}) as never);
});
describe("unexpected operation failures",()=>{
 it("journals an unknown post-admission failure as uncertain without repeating the physical action",async()=>{
  const perform=vi.fn(async()=>{throw new Error("private provider details");});
  await expect(operation(ctx,pool,"task",input,perform)).resolves.toEqual({ok:false,code:"OPERATION_OUTCOME_UNCERTAIN",uncertain:true});
  expect(perform).toHaveBeenCalledTimes(1);
  expect(finishOperation).toHaveBeenCalledWith(pool,"task","op","uncertain",null,"OPERATION_OUTCOME_UNCERTAIN",5,"attempt");
 });
 it("keeps known input failures actionable",async()=>{
  const perform=vi.fn(async()=>{throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Invalid");});
  await expect(operation(ctx,pool,"task",input,perform)).resolves.toEqual({ok:false,code:"TOOL_ARGUMENTS_INVALID",uncertain:false});
 });
 it("does not turn an admission outage into a fabricated operation receipt",async()=>{
  vi.mocked(beginOperation).mockRejectedValue(new Error("database unavailable"));
  const perform=vi.fn();
  await expect(operation(ctx,pool,"task",input,perform)).rejects.toThrow("database unavailable");
  expect(perform).not.toHaveBeenCalled();expect(finishOperation).not.toHaveBeenCalled();
 });
 it("limits admission retries and reports a lost acknowledgement as uncertain",async()=>{
  vi.mocked(beginOperation).mockRejectedValue(new Error("ack lost"));
  const retryCtx={run:async(_name:string,fn:()=>Promise<unknown>,options?:{maxRetryAttempts?:number})=>{
    for(let attempt=0;attempt<(options?.maxRetryAttempts??1);attempt++)try{return await fn();}catch{}
    throw new restate.TerminalError("admission failed");
  }} as unknown as restate.WorkflowContext;
  const perform=vi.fn();
  await expect(operation(retryCtx,pool,"task",input,perform)).resolves.toEqual({ok:false,code:"OPERATION_ADMISSION_UNAVAILABLE",uncertain:true});
  expect(beginOperation).toHaveBeenCalledTimes(3);expect(perform).not.toHaveBeenCalled();expect(finishOperation).not.toHaveBeenCalled();
 });
 it("retries transient admission errors before performing once",async()=>{
  vi.mocked(beginOperation).mockRejectedValueOnce(new Error("temporary"));
  const retryCtx={run:async(_name:string,fn:()=>Promise<unknown>,options?:{maxRetryAttempts?:number})=>{
    for(let attempt=0;attempt<(options?.maxRetryAttempts??1);attempt++)try{return await fn();}catch{}
    throw new restate.TerminalError("failed");
  }} as unknown as restate.WorkflowContext;
  const perform=vi.fn(async()=>({value:"done",tokens:0}));
  await expect(operation(retryCtx,pool,"task",input,perform)).resolves.toEqual({ok:true,value:"done"});
  expect(beginOperation).toHaveBeenCalledTimes(2);expect(perform).toHaveBeenCalledTimes(1);
 });
 it("propagates cancellation without classifying it as admission failure",async()=>{
  const perform=vi.fn(async()=>{throw new restate.CancelledError();});
  await expect(operation(ctx,pool,"task",input,perform)).rejects.toBeInstanceOf(restate.CancelledError);
  expect(finishOperation).not.toHaveBeenCalled();
 });

});
