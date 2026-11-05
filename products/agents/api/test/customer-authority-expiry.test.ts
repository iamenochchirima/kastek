import {describe,it,expect,vi,beforeEach} from "vitest";
import type {Pool} from "pg";
import type * as restate from "@restatedev/restate-sdk";
import {PlatformError} from "../src/contracts/contracts";
import {awaitAuthority} from "../src/execution/business/business";
import {loadExecution,assertCurrentAuthority,event} from "../src/execution/lifecycle/execution";

vi.mock("../src/execution/lifecycle/execution",async original=>({
 ...await original<typeof import("../src/execution/lifecycle/execution")>(),
 loadExecution:vi.fn(),assertCurrentAuthority:vi.fn(),event:vi.fn(),
}));
vi.mock("../src/infrastructure/database",()=>({transaction:async (_pool:unknown,fn:(db:unknown)=>Promise<unknown>)=>fn({})}));
const pool={query:vi.fn()} as unknown as Pool;
const promise=vi.fn(()=>({get:()=>({map:()=>Promise.resolve(true)})}));
const ctx={run:async(_name:string,fn:()=>Promise<unknown>)=>fn(),promise} as unknown as restate.WorkflowContext;
const execution=(kind:string,parent:string|null=null)=>({task:{state:"running",principal:{kind},parent_task_id:parent,control_generation:0,deadline_at:null,execution_policy_version:2}});
beforeEach(()=>{vi.resetAllMocks();vi.mocked(event).mockResolvedValue(undefined as never);});
describe("customer grant expiry",()=>{
 it.each(["visitor","channel_customer"])("finishes an expired %s root without waiting for impossible renewal",async kind=>{
  vi.mocked(loadExecution).mockResolvedValue(execution(kind) as never);
  vi.mocked(assertCurrentAuthority).mockRejectedValue(new PlatformError("AUTHORITY_EXPIRED",403,"Expired"));
  await expect(awaitAuthority(ctx,pool,"task","check")).rejects.toMatchObject({code:"AUTHORITY_EXPIRED"});
  expect(promise).not.toHaveBeenCalled();expect(pool.query).not.toHaveBeenCalled();
 });
 it("still waits for and resumes authorized human tasks",async()=>{
  vi.mocked(loadExecution).mockResolvedValue(execution("human") as never);
  vi.mocked(assertCurrentAuthority).mockRejectedValueOnce(new PlatformError("AUTHORITY_EXPIRED",403,"Expired")).mockResolvedValue(undefined as never);
  await expect(awaitAuthority(ctx,pool,"task","check")).resolves.toMatchObject({task:{principal:{kind:"human"}}});
  expect(promise).toHaveBeenCalledTimes(1);
 });
});
