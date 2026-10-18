import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toolDescriptor } from "../src/capabilities/tool-descriptors";
import { validateBuiltinArguments, validateBuiltinResult } from "../src/capabilities/tool-contracts";
import { BOOKING_REQUIREMENTS, verifyBookingReceipt } from "../src/contracts/workflows";
import { requestDigest } from "../src/contracts/contracts";

describe("executable built-in capability contracts",()=>{
  it("pins authority, resources, real schemas and effect recovery independently of offering labels",()=>{
    expect(toolDescriptor("report.deliver")).toMatchObject({requiredAuthority:["effect.deliver","artifact.read","artifact.write"],
      requiredResources:["exact_reviewed_artifact","current_destination","single_use_review"],retry:"status_only",reconciliation:"provider_receipt_only"});
    expect(toolDescriptor("agents.delegate")?.outputSchema).toHaveProperty("properties.children");
    expect(toolDescriptor("channel.request_handoff")).toMatchObject({effect:"channel_control",requiredResources:["current_channel_generation"]});
    expect(toolDescriptor("booking.confirm")).toBeUndefined();
  });
  it("rejects model-supplied authority, programs, credentials and arbitrary resources",()=>{
    expect(()=>validateBuiltinArguments("agents.delegate",{requests:[{bindingId:"approved",brief:"Find evidence",program:"root",grant:{operations:["all"]}}]})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
    expect(()=>validateBuiltinArguments("channel.request_handoff",{conversationId:randomUUID(),assigneeAccountId:randomUUID()})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
    expect(()=>validateBuiltinArguments("sandbox.analyze",{code:"print(1)",apiKey:"private"})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
    expect(()=>validateBuiltinArguments("knowledge.search",{query:"x".repeat(513)})).toThrow();
    expect(validateBuiltinArguments("knowledge.initial",{query:"x".repeat(1024)})).toBeDefined();
  });
  it("rejects invalid or credential-bearing results before they reach a model",()=>{
    expect(validateBuiltinResult("memory.propose",{candidateId:randomUUID(),status:"pending_review"})).toBeDefined();
    expect(()=>validateBuiltinResult("memory.propose",{candidateId:randomUUID(),status:"accepted"})).toThrowError(expect.objectContaining({code:"CAPABILITY_RESULT_INVALID"}));
    expect(()=>validateBuiltinResult("memory.propose",{candidateId:randomUUID(),status:"pending_review",authorization:"Bearer private"})).toThrow();
    expect(()=>validateBuiltinResult("agents.delegate",{children:[{taskId:"imagined",state:"completed",output:"Looks done"}],partial:false})).toThrow();
  });
});

describe("unavailable booking provider contract",()=>{
  const intent={resourceId:"calendar/room-1",startsAt:"2026-11-02T08:00:00Z",endsAt:"2026-11-02T09:00:00Z",expectedProviderRevision:"v17",requestKey:"booking-1"};
  it("requires an exact intent-linked provider confirmation rather than generated text",()=>{
    expect(BOOKING_REQUIREMENTS.available).toBe(false);
    expect(()=>verifyBookingReceipt(intent,{state:"confirmed",text:"Your booking is confirmed"})).toThrow();
    const receipt={state:"confirmed",intentDigest:requestDigest(intent),providerBookingId:"provider-91",providerRevision:"v18",receiptId:"receipt-91"};
    expect(verifyBookingReceipt(intent,receipt).state).toBe("confirmed");
    expect(()=>verifyBookingReceipt({...intent,resourceId:"calendar/room-2"},receipt)).toThrowError(expect.objectContaining({code:"BOOKING_RECEIPT_CONFLICT"}));
  });
  it("preserves provider conflict and uncertainty as distinct outcomes",()=>{
    expect(verifyBookingReceipt(intent,{state:"conflict",intentDigest:requestDigest(intent),providerRevision:"v18"}).state).toBe("conflict");
    expect(verifyBookingReceipt(intent,{state:"uncertain",intentDigest:requestDigest(intent),reconciliationKey:"original-request-key"}).state).toBe("uncertain");
  });
});
