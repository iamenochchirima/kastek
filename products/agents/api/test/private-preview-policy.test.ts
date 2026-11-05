import { describe,expect,it } from "vitest";
import { assertPrivatePreviewOperation } from "../src/execution/lifecycle/preview-policy";

describe("private preview operations",()=>{
  it("permits answering with approved knowledge and blocks external effects and delegation",()=>{
    for(const operation of [{kind:"model",name:"model.generate"},{kind:"compaction",name:"context.compact"},
      {kind:"tool",name:"knowledge.search"},{kind:"tool",name:"knowledge.read"}])
      expect(()=>assertPrivatePreviewOperation(operation)).not.toThrow();
    for(const operation of [{kind:"tool",name:"booking.execute"},{kind:"tool",name:"enquiry.submit"},
      {kind:"tool",name:"external_tool_alias"},{kind:"delegation",name:"agents.start"},
      {kind:"resource",name:"artifact.create"},{kind:"tool",name:"memory.propose"}])
      expect(()=>assertPrivatePreviewOperation(operation)).toThrowError(/unavailable/);
    expect(()=>assertPrivatePreviewOperation({kind:"model",name:"model.generate"},true)).toThrowError(/unavailable/);
  });
});
