import { randomUUID } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import type { Pool } from "pg";
import type { GrowthAgentCommand } from "@kasitek-labs/contracts";
import { GrowthExecutionService } from "../src/product/integrations/growth-execution";
import { observeGrowthTask } from "../src/product/integrations/growth-observation";
import { PlatformError } from "../src/contracts/contracts";
import { assertCurrentEvidence,taskEvidenceManifest } from "../src/execution/context/evidence-policy";
vi.mock("../src/execution/context/evidence-policy",async original=>({...await original<typeof import("../src/execution/context/evidence-policy")>(),assertCurrentEvidence:vi.fn(),taskEvidenceManifest:vi.fn()}));
afterEach(()=>vi.restoreAllMocks());
function fixture(withChild=false) {
 const id=randomUUID(),org=randomUUID(),child=randomUUID(),now=new Date("2026-11-02T10:00:00Z");
 const root={id,root_task_id:id,parent_task_id:null,principal:{kind:"human",issuer:"fixture",subject:"owner"},organization_id:org,version_id:randomUUID(),feature_id:"assistant",conversation_id:randomUUID(),input:"Original request",output:null,state:"running",created_at:now,updated_at:now};
 const queries:{sql:string;values:any[]}[]=[];
 const operation=(n:number)=>({id:`tool:${id}:${n}`,cursor_id:String(n).padStart(32,"0"),cursor_position:`2026-11-02T10:00:00.12345${n}Z`,task_id:id,kind:"tool",name:"content.list",state:"completed",started_at:now,completed_at:now,error_code:null});
 const pool={query:vi.fn(async(sql:string,values:any[])=>{queries.push({sql,values});
   if(sql.includes("WITH RECURSIVE family"))return {rows:withChild?[{...root,id:child,parent_task_id:id,agent_name:"Content",input:"PROTECTED_DERIVED_ASSIGNMENT",output:"PROTECTED_DERIVED_OUTPUT"}]:[]};
   if(sql.includes("SELECT o.id,md5"))return {rows:values[2]?[operation(1)]:[operation(4),operation(3),operation(2)]};
   if(sql.includes("SELECT a.name"))return {rows:[{name:"Growth assistant"}]};
   return {rows:[]};
 })} as unknown as Pool;
 const service=new GrowthExecutionService(pool,{issuer:"fixture",actorIssuer:"fixture",keys:{}});
 Object.defineProperty(service,"runtime",{value:{authorizeTask:vi.fn().mockResolvedValue(undefined)}});
 vi.spyOn(service,"task").mockResolvedValue(root as never);
 vi.spyOn(service,"taskDto").mockResolvedValue({id,conversationId:root.conversation_id,featureId:"assistant",state:"working",input:root.input,output:null,errorCode:null,createdAt:now.toISOString(),updatedAt:now.toISOString(),updates:[]} as never);
 vi.mocked(assertCurrentEvidence).mockResolvedValue(undefined);vi.mocked(taskEvidenceManifest).mockResolvedValue({}as never);
 const command:Extract<GrowthAgentCommand,{operation:"tasks.observe"}>={version:"1",tenantId:"tenant",requestId:randomUUID(),actor:{issuer:"fixture",subject:"owner"},operation:"tasks.observe",input:{taskId:id,limit:2}};
 return {id,child,org,pool,service,command,queries};
}
it("pages own safe operations without splitting timestamp precision or exposing arbitrary operation payloads",async()=>{
 const f=fixture(),first=await observeGrowthTask(f.service,f.command);
 expect(first.operations).toHaveLength(2);expect(first.operations.map(op=>op.label)).toEqual(["Finding content","Finding content"]);expect(first.nextOperationCursor).toBeTruthy();
 expect(JSON.stringify(first)).not.toMatch(/tool_calls|request_digest|cursor_id|arguments/);
 await observeGrowthTask(f.service,{...f.command,input:{...f.command.input,operationCursor:first.nextOperationCursor!}});
 const queries=f.queries.filter(query=>query.sql.includes("SELECT o.id,md5"));
 expect(queries[1]!.values[2]).toBe("2026-11-02T10:00:00.123453Z");expect(queries[1]!.values[3]).toBe("3".padStart(32,"0"));
 expect(queries[0]!.sql).toContain("WHERE o.task_id=$1");
 await expect(observeGrowthTask(f.service,{...f.command,actor:{...f.command.actor,subject:"other"},input:{...f.command.input,operationCursor:first.nextOperationCursor!}})).rejects.toMatchObject({code:"INVALID_CURSOR"});
});
it.each([403,404,409,503])("does not return assignment, updates, operations or output after evidence withdrawal (%i)",async status=>{
 const f=fixture();vi.mocked(assertCurrentEvidence).mockRejectedValue(new PlatformError("EVIDENCE_UNAVAILABLE",status,"Withdrawn"));
 const result=await observeGrowthTask(f.service,f.command);
 expect(result.task).toMatchObject({id:f.id,input:"Original request",output:null,errorCode:"EVIDENCE_UNAVAILABLE",updates:[],children:[],sources:[],results:[]});
 expect(result).toMatchObject({operations:[],updates:[],events:[],nextCursor:null,nextOperationCursor:null});expect(result.task).not.toHaveProperty("runtime");
 expect(f.service.taskDto).not.toHaveBeenCalled();expect(f.queries).toHaveLength(0);
});
it("requires a scoped ancestry lookup for a child and never falls back to export or unrelated task detail",async()=>{
 const f=fixture();await expect(observeGrowthTask(f.service,{...f.command,input:{...f.command.input,childTaskId:f.child}})).rejects.toMatchObject({code:"NOT_FOUND"});
 const query=f.queries[0]!;expect(query.sql).toContain("WITH RECURSIVE family");expect(query.sql).toContain("t.root_task_id=$1 AND t.organization_id=$3 AND t.principal=$4::jsonb AND t.product='growth'");expect(query.sql).toContain("c.deleted_at IS NULL");expect(query.sql).toContain("f.enabled");expect(query.values).toEqual([f.id,f.child,f.org,JSON.stringify({kind:"human",issuer:"fixture",subject:"owner"}),"tenant"]);
 expect(f.service.taskDto).not.toHaveBeenCalled();
});

it.each([409,503])("returns a restorable fully redacted child observation on evidence-policy status %i",async status=>{
 const f=fixture(true);vi.mocked(assertCurrentEvidence).mockRejectedValue(new PlatformError("EVIDENCE_INTEGRITY",status,"Private evidence detail"));
 const result=await observeGrowthTask(f.service,{...f.command,input:{...f.command.input,childTaskId:f.child}});
 expect(result.task).toMatchObject({id:f.child,input:"",output:null,errorCode:"EVIDENCE_UNAVAILABLE"});
 expect(result).toMatchObject({operations:[],updates:[],events:[],nextCursor:null,nextOperationCursor:null});
 expect(JSON.stringify(result)).not.toMatch(/PROTECTED|Private evidence detail/);
});
it("does not disguise an ordinary product-authority outage as evidence withdrawal",async()=>{
 const f=fixture();vi.mocked(f.service.task).mockRejectedValue(new PlatformError("PRODUCT_ACTIONS_UNAVAILABLE",503,"Backend unavailable"));
 await expect(observeGrowthTask(f.service,f.command)).rejects.toMatchObject({code:"PRODUCT_ACTIONS_UNAVAILABLE",statusCode:503});
});
it("restores a child only after a later successful evidence check without rewriting its native output",async()=>{
 const f=fixture(true);vi.mocked(assertCurrentEvidence).mockRejectedValueOnce(new PlatformError("EVIDENCE_UNAVAILABLE",403,"Unavailable"));
 const request={...f.command,input:{...f.command.input,childTaskId:f.child}};
 const hidden=await observeGrowthTask(f.service,request);expect(hidden.task.output).toBeNull();
 const restored=await observeGrowthTask(f.service,request);expect(restored.task).toMatchObject({id:f.child,input:"PROTECTED_DERIVED_ASSIGNMENT",output:"PROTECTED_DERIVED_OUTPUT"});
 expect(restored.task.observedAt!>=hidden.task.observedAt!).toBe(true);
});
