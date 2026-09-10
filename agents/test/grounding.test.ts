import { describe, expect, it } from "vitest";
import { classifyAgentIntent, isKnowledgeSeekingMessage, shouldFailClosedWithoutEvidence } from "../src/runtime/grounding";

describe("agent grounding", () => {
  it("recognizes factual customer questions without blocking greetings or effect requests", () => {
    expect(isKnowledgeSeekingMessage("What are the things you can help me with?")).toBe(false);
    expect(isKnowledgeSeekingMessage("Tell me about your pricing")).toBe(true);
    expect(isKnowledgeSeekingMessage("Hi")).toBe(false);
    expect(isKnowledgeSeekingMessage("Please publish this post")).toBe(false);
    expect(isKnowledgeSeekingMessage("What do I have on my Google calendar?")).toBe(false);
  });

  it("fails closed only for customer-facing agents with no trusted evidence", () => {
    expect(shouldFailClosedWithoutEvidence({ message: "What are the things you can help me with?", agentAudience: "customer_service", evidenceCount: 0 })).toBe(false);
    expect(shouldFailClosedWithoutEvidence({ message: "What is your refund policy?", agentAudience: "customer_service", evidenceCount: 0 })).toBe(true);
    expect(shouldFailClosedWithoutEvidence({ message: "What is your refund policy?", agentAudience: "customer_service", evidenceCount: 1 })).toBe(false);
    expect(classifyAgentIntent("What are the things you can help me with?")).toBe("capability_request");
    expect(classifyAgentIntent("What do I have on my Google calendar?")).toBe("capability_request");
    expect(shouldFailClosedWithoutEvidence({ message: "What do I have on my Google calendar?", agentAudience: "customer_service", evidenceCount: 0 })).toBe(false);
  });
});
