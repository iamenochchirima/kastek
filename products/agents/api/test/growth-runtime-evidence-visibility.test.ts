import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import type { GrowthAgentCommand } from "@kasitek-labs/contracts";
import { GrowthExecutionService } from "../src/product/integrations/growth-execution";
import { PlatformError } from "../src/contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../src/execution/context/evidence-policy";
vi.mock("../src/execution/context/evidence-policy",async importOriginal=>({
  ...await importOriginal<typeof import("../src/execution/context/evidence-policy")>(),
  assertCurrentEvidence:vi.fn(),taskEvidenceManifest:vi.fn(),
}));
afterEach(()=>vi.restoreAllMocks());
function fixture(){
  const conversationId=randomUUID(),id=randomUUID(),organizationId=randomUUID();
  const pool={query:vi.fn()} as unknown as Pool;
  const service=new GrowthExecutionService(pool,{issuer:"https://growth.fixture",actorIssuer:"https://identity.fixture",keys:{}});
  const task={id,conversation_id:conversationId,feature_id:"assistant",organization_id:organizationId,root_task_id:id,
    input:"My own original human request",output:"WITHDRAWN_ASSISTANT_OUTPUT",sources:[{id:"WITHDRAWN_SOURCE",title:"Source",revision:"1"}],
    state:"completed",created_at:new Date("2026-11-02T10:00:00Z"),updated_at:new Date("2026-11-02T10:00:01Z")};
  vi.mocked(taskEvidenceManifest).mockResolvedValue({} as never);
  return{service,pool,task,conversationId,organizationId};
}
it.each([403,404,409,503])("redacts withdrawn runtime/output with a fresh observation timestamp on evidence status %s",async status=>{
  const {service,pool,task}=fixture(),before=Date.now();
  vi.mocked(assertCurrentEvidence).mockRejectedValue(new PlatformError("EVIDENCE_UNAVAILABLE",status,"Withdrawn"));
  const result=await service.taskDto(task);
  expect(result).toMatchObject({id:task.id,input:task.input,output:null,errorCode:"EVIDENCE_UNAVAILABLE",sources:[],results:[],reviewIds:[]});
  expect(Number.isFinite(Date.parse(result.observedAt!))).toBe(true);
  expect(Date.parse(result.observedAt!)).toBeGreaterThanOrEqual(before);
  expect(result).not.toHaveProperty("runtime");expect(result.updatedAt).toBe(task.updated_at.toISOString());
  expect(JSON.stringify(result)).not.toMatch(/WITHDRAWN_ASSISTANT_OUTPUT|WITHDRAWN_SOURCE/);
  expect(pool.query).not.toHaveBeenCalled();
});
it("does not disguise an unexpected evidence failure as a successful redacted observation",async()=>{
  const{service,task}=fixture();const failure=new Error("database unavailable");vi.mocked(assertCurrentEvidence).mockRejectedValue(failure);
  await expect(service.taskDto(task)).rejects.toBe(failure);
});
it("conversation reload removes withdrawn assistant text/sources but preserves own requests and corrections; a later authorized read restores output",async()=>{
  const{service,pool,task,conversationId,organizationId}=fixture();
  const conversation={conversation_id:conversationId,organization_id:organizationId,feature_id:"assistant",title:"Fixture",context:null,created_at:task.created_at,updated_at:task.updated_at};
  vi.spyOn(service,"tenant").mockResolvedValue({organization_id:organizationId});
  vi.spyOn(service,"conversation").mockResolvedValue(conversation);
  vi.spyOn(service,"authorizeConversation").mockResolvedValue(undefined as never);
  vi.spyOn(service,"task").mockResolvedValue(task);
  vi.spyOn(service.store,"getConversationPage").mockResolvedValue({items:[{id:task.id}],nextCursor:null} as never);
  vi.mocked(pool.query).mockImplementation(async(sql:string)=>({rows:sql.includes("orchestration_instructions")?[{sequence:1,instruction:"My own correction",created_at:task.created_at}]:[{id:task.id}]} as never));
  const command={version:"1",requestId:randomUUID(),tenantId:"owned-tenant",actor:{issuer:"https://identity.fixture",subject:"owner"},operation:"conversations.get",input:{conversationId}} as GrowthAgentCommand;
  vi.mocked(assertCurrentEvidence).mockRejectedValue(new PlatformError("EVIDENCE_UNAVAILABLE",403,"Withdrawn"));
  const withdrawn=await service.execute(command) as {messages:{role:string;text:string;sources?:unknown[]}[]};
  expect(withdrawn.messages.map(message=>[message.role,message.text])).toEqual([["user",task.input],["user","My own correction"]]);
  expect(JSON.stringify(withdrawn)).not.toMatch(/WITHDRAWN_ASSISTANT_OUTPUT|WITHDRAWN_SOURCE/);
  expect(vi.mocked(assertCurrentEvidence)).toHaveBeenCalledWith(pool,task.id,{}, {requireActiveTask:false});
  vi.mocked(assertCurrentEvidence).mockResolvedValue(undefined);
  const authorized=await service.execute(command) as {messages:{role:string;text:string;sources?:unknown[]}[]};
  expect(authorized.messages.filter(message=>message.role==="assistant")).toEqual([expect.objectContaining({text:task.output,sources:task.sources})]);
});
