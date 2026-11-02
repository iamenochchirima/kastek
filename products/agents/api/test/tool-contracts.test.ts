import { z } from "zod";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toolDescriptor } from "../src/capabilities/tool-descriptors";
import { builtinContract, capabilityContractMetadata, validateBuiltinArguments, validateBuiltinResult } from "../src/capabilities/tool-contracts";
import { BOOKING_REQUIREMENTS, verifyBookingReceipt } from "../src/contracts/workflows";
import {toolsFor} from "../src/capabilities/tools";
import {defaultBusinessConfiguration} from "../src/contracts/contracts";
import { requestDigest } from "../src/contracts/contracts";

describe("executable built-in capability contracts",()=>{
  it("pins authority, resources, real schemas and effect recovery independently of offering labels",()=>{
    expect(toolDescriptor("report.deliver")).toMatchObject({requiredAuthority:["effect.deliver","artifact.read","artifact.write"],
      requiredResources:["exact_reviewed_artifact","current_destination","single_use_review"],retry:"status_only",reconciliation:"provider_receipt_only"});
    expect(toolDescriptor("agents.delegate")?.outputSchema).toHaveProperty("properties.children");
    expect(toolDescriptor("channel.request_handoff")).toMatchObject({effect:"channel_control",requiredResources:["current_channel_generation"]});
    expect(toolDescriptor("booking.confirm")).toBeUndefined();
  });
  it("reuses only immutable built-in JSON metadata while preserving every published descriptor digest",()=>{
    const originalDigests={
      "knowledge.initial": "72fcb329441eee479caf43472abc688b998ca4c8bd730703845b0b2a9cd58fa2",
      "knowledge.search": "b4690a3e7b57466ad58eb6631a1cf3cb2e8c0eb696e7e303f146a1c9f41e3c95",
      "knowledge.read": "26b7c53a8d61e14e02ba0217ae87d63689ff0379911319447ef60002eb46d3eb",
      "memory.search": "60dc187245c3d1e05bd99309370d0fce0e8cb7a11c09a15ccccd18d874435a1d",
      "memory.propose": "c1a26d5d99bacdfd178adcb40252249be4dabdc23fffe1b40d9b91e7afaf5f2e",
      "agents.delegate": "6c3caac399c90ff8b30a701b6f633a8494c3d093b2ff802f790ad0da4e7d6cd5",
      "sandbox.analyze": "4f52a71ceb9d0968d357b0cc2ea0c615026f17f0d28938a2f37e22ce3c3ee98a",
      "channel.request_handoff": "6c6bec7a5b56dc7e26b67a06caa067c86e17b9ff8befec3acbb6e03c20a6f36a",
      "report.deliver": "2926bf50ff9385e4075c213dd26564cb7135f42e92f37186f0c75ecc67090bb7"
};
    for(const[name,digest]of Object.entries(originalDigests)){
      const contract=builtinContract(name)!,metadata=capabilityContractMetadata(name);
      expect(metadata).toBe(capabilityContractMetadata(name));
      expect(metadata.inputSchema).toEqual(z.toJSONSchema(contract.input));expect(metadata.outputSchema).toEqual(z.toJSONSchema(contract.output));
      expect(requestDigest(toolDescriptor(name))).toBe(digest);
      const visit=(value:unknown):void=>{if(value!==null&&typeof value==="object"){expect(Object.isFrozen(value)).toBe(true);for(const child of Object.values(value))visit(child);}};
      visit(metadata);
      expect(()=>{(metadata.inputSchema as Record<string,unknown>).poisoned=true;}).toThrow();
      expect(()=>{(metadata.requiredAuthority as string[]).push("all");}).toThrow();
      expect(()=>{(metadata.requiredResources as string[]).splice(0,1);}).toThrow();
      expect(requestDigest(toolDescriptor(name))).toBe(digest);
      expect(Object.isFrozen(contract.input)).toBe(false);expect(Object.isFrozen(contract.output)).toBe(false);
    }
    expect(()=>capabilityContractMetadata("__proto__")).toThrowError(expect.objectContaining({code:"CAPABILITY_RELEASE_UNAVAILABLE"}));
    expect(()=>capabilityContractMetadata("unknown")).toThrowError(expect.objectContaining({code:"CAPABILITY_RELEASE_UNAVAILABLE"}));
  });
  it("rejects model-supplied authority, programs, credentials and arbitrary resources",()=>{
    expect(()=>validateBuiltinArguments("agents.delegate",{requests:[{bindingId:"approved",brief:"Find evidence",program:"root",grant:{operations:["all"]}}]})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
    expect(()=>validateBuiltinArguments("channel.request_handoff",{conversationId:randomUUID(),assigneeAccountId:randomUUID()})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
    expect(()=>validateBuiltinArguments("sandbox.analyze",{code:"print(1)",apiKey:"private"})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
    expect(()=>validateBuiltinArguments("knowledge.search",{query:"x".repeat(513)})).toThrow();
    expect(validateBuiltinArguments("knowledge.initial",{query:"x".repeat(1024)})).toBeDefined();
  });
  it("derives skill execution only from selected skills and separately enabled sandbox authority",()=>{
    const config=defaultBusinessConfiguration(),names=()=>toolsFor(config).map(tool=>tool.function.name);
    expect(names()).not.toContain("skills_run");config.skillIds=[randomUUID()];expect(names()).not.toContain("skills_run");
    config.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};expect(names()).not.toContain("skills_run");config.tools=["sandbox.analyze"];expect(names()).toContain("skills_run");
    expect(toolDescriptor("skills.run")).toMatchObject({effect:"resource",requiredProfile:"python-analysis-v1",requiredAuthority:["skill.read","sandbox.execute","artifact.read","artifact.write"],maxDurationMs:240000,retry:"adapter_reconcile"});
    expect(validateBuiltinArguments("skills.run",{skillId:config.skillIds[0],path:"scripts/report.py"})).toBeDefined();
    for(const extra of [{code:"print(1)"},{environment:{KEY:"secret"}},{install:["requests"]},{command:"sh"}])expect(()=>validateBuiltinArguments("skills.run",{skillId:config.skillIds[0],path:"scripts/report.py",...extra})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
  });
  it("accepts native staff record fields without applying customer submission input rules",()=>{
    const record={enquiryId:randomUUID(),fields:{name:"Staff entry",email:"",phone:"",service:"s".repeat(500)},status:"new",revision:"1",dueAt:null};
    expect(validateBuiltinResult("records.search",{records:[record]})).toEqual({records:[record]});
    expect(()=>validateBuiltinResult("records.search",{records:[{...record,fields:{...record.fields,service:"s".repeat(501)}}]})).toThrowError(expect.objectContaining({code:"CAPABILITY_RESULT_INVALID"}));
    expect(()=>validateBuiltinResult("records.search",{records:[{...record,privateNotes:"Keep private"}]})).toThrowError(expect.objectContaining({code:"CAPABILITY_RESULT_INVALID"}));
    expect(()=>validateBuiltinArguments("enquiry.submit",{fields:{email:"",service:"s".repeat(500)}})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
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
