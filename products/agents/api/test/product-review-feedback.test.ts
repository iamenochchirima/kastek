import {describe,it,expect,vi} from "vitest";
import type {Pool} from "pg";
import type {WorkflowContext} from "@restatedev/restate-sdk";
import type {CapabilityBinding} from "../src/contracts/capability-catalog";
import type {ProductRuntimePort} from "../src/execution/products/product-runtime";
import {PlatformError} from "../src/contracts/contracts";
import {awaitProductReview} from "../src/execution/business/product-review";

describe("product review preparation feedback",()=>{
  it.each(["TOOL_ARGUMENTS_INVALID","AGENT_DESTINATION_REQUIRED","AGENT_DESTINATION_UNAVAILABLE"])("lets the model correct %s before a review exists",async code=>{
    const runtime={authorizeTask:vi.fn(async()=>{}),prepare:vi.fn(async()=>{throw new PlatformError(code,422,"Check the proposal");})} as unknown as ProductRuntimePort;
    const ctx={run:async(_name:string,action:()=>Promise<unknown>)=>action()} as unknown as WorkflowContext;
    const db={query:vi.fn()} as unknown as Pool;
    await expect(awaitProductReview(ctx,db,runtime,"task","operation",{} as CapabilityBinding,{})).resolves.toEqual({errorCode:code});
    expect(db.query).not.toHaveBeenCalled();
  });
  it.each(["PRODUCT_AUTHORITY_INACTIVE","PRODUCT_EFFECT_UNCERTAIN","INTERNAL_ERROR"])("does not turn %s into a retryable proposal",async code=>{
    const runtime={authorizeTask:vi.fn(async()=>{}),prepare:vi.fn(async()=>{throw new PlatformError(code,403,"Unavailable");})} as unknown as ProductRuntimePort;
    const ctx={run:async(_name:string,action:()=>Promise<unknown>)=>action()} as unknown as WorkflowContext;
    await expect(awaitProductReview(ctx,{} as Pool,runtime,"task","operation",{} as CapabilityBinding,{})).resolves.toEqual({outcome:{state:"incomplete",errorCode:code}});
  });
});
