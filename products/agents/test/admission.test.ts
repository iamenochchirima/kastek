import { describe, expect, it } from "vitest";
import { admissionDecision, agentAdmissionOutcomeSchema, sameSessionSerializationPolicy } from "../src/runtime/admission";

describe("agent admission contract", () => {
  it("describes durable same-session queueing explicitly", () => {
    expect(agentAdmissionOutcomeSchema.options).toEqual(["accepted", "queued", "limited", "rejected"]);
    expect(admissionDecision({ outcome: "queued", reasonCode: "conversation_run_active", policy: sameSessionSerializationPolicy })).toEqual({
      outcome: "queued",
      reasonCode: "conversation_run_active",
      retryable: false,
      policy: sameSessionSerializationPolicy,
    });
  });
});
