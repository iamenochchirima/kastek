import { describe, expect, it } from "vitest";
import { createDependencyManifest } from "../src/contracts/source-contracts";
import { parseHandoffFeedbackRequest } from "../src/execution/lifecycle/handoff-feedback-contract";
import { beginHandoffFeedbackOperation } from "../src/execution/lifecycle/execution";
import type { Pool } from "pg";

const request = () => ({modelRequest:{model:"fixture",messages:[{role:"user",content:"Please connect me"}],maxInputTokens:80,maxOutputTokens:20,maxDurationSeconds:1},evidenceManifest:createDependencyManifest([])});
describe("handoff feedback request", () => {
  it("accepts a canonical tool-free model snapshot", () => { expect(parseHandoffFeedbackRequest(request())).toEqual(request()); });
  it("rejects model-callable tools and altered evidence digests", () => {
    const valid=request();
    expect(() => parseHandoffFeedbackRequest({...valid,modelRequest:{...valid.modelRequest,tools:[]}})).toThrow();
    expect(() => parseHandoffFeedbackRequest({...valid,evidenceManifest:{...valid.evidenceManifest,digest:"0".repeat(64)}})).toThrow();
  });
  it("rejects unrelated or under-reserved operations before touching the database", async () => {
    const valid=request(),pool={} as Pool;
    const input={id:"handoff-feedback:task",kind:"model" as const,name:"model.handoff_feedback",request:valid,evidenceManifest:valid.evidenceManifest,reservedTokens:100,reservedMs:1000};
    await expect(beginHandoffFeedbackOperation(pool,"task",{...input,name:"model.generate"})).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
    await expect(beginHandoffFeedbackOperation(pool,"task",{...input,reservedTokens:99})).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
    await expect(beginHandoffFeedbackOperation(pool,"task",{...input,reservedMs:999})).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
  });
});
