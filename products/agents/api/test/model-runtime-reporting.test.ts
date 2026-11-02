import { expect,it,vi } from "vitest";
import { randomUUID } from "node:crypto";
import { invokeObservedTaskModel } from "../src/execution/models/observed-invocation";
import { invokeTaskModel,type TaskModelInvocation } from "../src/execution/models/runtime";
import { recordEvent } from "../src/observability/event-store";
vi.mock("../src/execution/models/runtime",()=>({invokeTaskModel:vi.fn()}));
vi.mock("../src/observability/event-store",()=>({recordEvent:vi.fn()}));
const input=()=>({pool:{},execution:{models:{primary:{binding:{connectionId:randomUUID(),providerId:"fixture",protocol:"openai_chat_completions",modelId:"fixture/model",role:"chat",adapterRevision:"1"},policy:{digest:"a".repeat(64)},model:{pricing:null}}},task:{id:randomUUID(),root_task_id:randomUUID(),organization_id:randomUUID(),harness_release:"fixture"}},operationId:"model:fixture:0",role:"primary",messages:[{role:"user",content:"PRIVATE_PROMPT"}]})as unknown as TaskModelInvocation;
it("persists only scalar invocation timing and never blocks settlement on reporting",async()=>{
  vi.spyOn(console,"info").mockImplementation(()=>{});
  vi.mocked(recordEvent).mockImplementation(()=>new Promise(()=>{}));
  vi.mocked(invokeTaskModel).mockImplementation(async options=>{options.onText?.("PRIVATE_RESPONSE");return{message:{role:"assistant",content:"PRIVATE_RESPONSE"},finishReason:"stop",usage:{observed:true,inputTokens:4,outputTokens:2}};});
  const request=input(),response=await invokeObservedTaskModel(request);
  expect(response.finishReason).toBe("stop");
  expect(recordEvent).toHaveBeenCalledWith(request.pool,request.execution.task.id,"model-observed:model:fixture:0","model.observed",{operationId:"model:fixture:0",role:"primary",durationMs:expect.any(Number),firstTokenMs:expect.any(Number),outputTokens:2});
  expect(JSON.stringify(vi.mocked(recordEvent).mock.calls)).not.toMatch(/PRIVATE|messages|credential/);
});
it("keeps failed model uncertainty and unavailable timing when the reporting database rejects",async()=>{
  vi.spyOn(console,"info").mockImplementation(()=>{});vi.mocked(recordEvent).mockRejectedValue(Error("reporting unavailable"));
  const failure=Object.assign(Error("PRIVATE_FAILURE"),{code:"MODEL_STREAM_FAILED",outcome:"uncertain",status:502});vi.mocked(invokeTaskModel).mockRejectedValue(failure);
  await expect(invokeObservedTaskModel(input())).rejects.toBe(failure);
  const payload=vi.mocked(recordEvent).mock.calls.at(-1)![4];expect(payload).not.toHaveProperty("firstTokenMs");expect(payload).not.toHaveProperty("outputTokens");
});
