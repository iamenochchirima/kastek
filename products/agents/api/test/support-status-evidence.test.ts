import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { StatusNoticeBinding } from "../src/product/inbox/support-status-notice";
import { requestDigest } from "../src/contracts/contracts";

const fixture=vi.hoisted(()=>({
  facts:{hours:{state:"open"},staffAvailability:"unknown",responseTime:"unknown",nextOpening:null},
  execution:{task:{organization_id:"organization",input:"Any update?"},configuration:{supportHours:{}}},
  evidenceAllowed:true,
}));
vi.mock("../src/execution/lifecycle/state",()=>({loadExecution:async()=>fixture.execution,inspectInboxOutput:async(fn:()=>Promise<unknown>)=>fn()}));
vi.mock("../src/capabilities/support-status-v2",()=>({supportStatusV2:async()=>fixture.facts}));
vi.mock("../src/execution/business/support-status-request",()=>({supportStatusRequest:(_execution:unknown,facts:unknown)=>({messages:[facts,"Any update?"]})}));
vi.mock("../src/execution/context/evidence-policy",()=>({
  taskEvidenceManifest:async()=>({}), assertCurrentEvidence:async()=>{if(!fixture.evidenceAllowed){const {PlatformError}=await import("../src/contracts/contracts");throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"Unavailable");}},
}));
import { verifyHistoricalSupportStatusEvidence,verifySupportStatusFacts } from "../src/product/inbox/support-status-evidence";

describe("support status fact verification",()=>{
  const binding:StatusNoticeBinding={taskId:"task",organizationId:"organization",conversationId:"conversation",inputMessageId:"input",episodeCommandId:"episode",ownershipGeneration:"2"};
  beforeEach(()=>{fixture.evidenceAllowed=true;fixture.facts.hours.state="open";});
  it("accepts only the current controller-built request and linked visitor input",async()=>{
    const request={supportFacts:structuredClone(fixture.facts),modelRequest:{messages:[structuredClone(fixture.facts),"Any update?"]}};
    const db={query:async()=>({rows:[{request,request_digest:requestDigest(request),body:"Any update?"}]})} as unknown as PoolClient;
    expect(await verifySupportStatusFacts(db,binding,"Waiting")).toBe(true);
    fixture.facts.hours.state="closed";
    expect(await verifySupportStatusFacts(db,binding,"Waiting")).toBe(false);
    expect(await verifyHistoricalSupportStatusEvidence(db,binding,"Waiting")).toBe(true);
  });
  it("fails closed when evidence is withdrawn or the visitor input changes",async()=>{
    const request={supportFacts:structuredClone(fixture.facts),modelRequest:{messages:[structuredClone(fixture.facts),"Any update?"]}};
    const db={query:async()=>({rows:[{request,request_digest:requestDigest(request),body:"Any update?"}]})} as unknown as PoolClient;
    fixture.evidenceAllowed=false;expect(await verifySupportStatusFacts(db,binding,"Waiting")).toBe(false);
    expect(await verifyHistoricalSupportStatusEvidence(db,binding,"Waiting")).toBe(false);
    fixture.evidenceAllowed=true;
    const altered={query:async()=>({rows:[{request,request_digest:requestDigest(request),body:"Different"}]})} as unknown as PoolClient;
    expect(await verifySupportStatusFacts(altered,binding,"Waiting")).toBe(false);
  });
});
