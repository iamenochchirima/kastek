import { describe, expect, it } from "vitest";
import { classifyHandoffIntent } from "../src/handoff/intent";

describe("deterministic handoff intent", () => {
  it("treats a clear customer request for a person as consent", () => {
    expect(classifyHandoffIntent("Please connect me to a human", false)).toMatchObject({
      kind: "request_human",
      classifierVersion: "v1-en",
    });
  });

  it("does not treat incidental uses of human or agent as a request", () => {
    expect(classifyHandoffIntent("I am a human asking about your AI agent", false).kind).toBe("other");
  });

  it("accepts only explicit confirmation while an offer is pending", () => {
    expect(classifyHandoffIntent("Yes, please do that", true).kind).toBe("confirm_handoff");
    expect(classifyHandoffIntent("No thanks, keep helping me", true).kind).toBe("decline_handoff");
    expect(classifyHandoffIntent("Can you tell me more first?", true).kind).toBe("ambiguous");
  });

  it("does not turn an unscoped yes into a handoff", () => {
    expect(classifyHandoffIntent("yes", false).kind).toBe("other");
  });

  it("keeps structured direct requests distinct from offer confirmations", () => {
    expect(classifyHandoffIntent({ handoffAction: "request_human" }, false).kind).toBe("request_human");
    expect(classifyHandoffIntent({ handoffAction: "confirm_handoff" }, true).kind).toBe("confirm_handoff");
  });
});
