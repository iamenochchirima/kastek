import { describe, expect, it } from "vitest";
import { admissionDecision, agentAdmissionOutcomeSchema, sameSessionSerializationPolicy } from "../src/runtime/admission";

describe("agent admission contract", () => {
  it("keeps the first-chunk outcomes explicit", () => {
    expect(agentAdmissionOutcomeSchema.options).toEqual(["accepted", "queued", "limited", "rejected"]);
    expect(admissionDecision({ outcome: "rejected", reasonCode: "conversation_run_active", retryable: true, policy: sameSessionSerializationPolicy })).toEqual({
      outcome: "rejected",
      reasonCode: "conversation_run_active",
      retryable: true,
      policy: sameSessionSerializationPolicy,
    });
  });
});
