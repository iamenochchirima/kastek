import { describe, expect, it } from "vitest";
import { agentConfigurationSchema, defaultBusinessConfiguration } from "../src/contracts/contracts";
import { defaultAgentGuidance, defaultAgentIdentity } from "../src/product/agents/identity";
import { composeAgentInstructions, renderGuidance, renderIdentity } from "../src/execution/context/agent-identity";

const base = () => ({ ...defaultBusinessConfiguration(), instructions: "Follow the task rules." });

describe("agent identity composition", () => {
  it("keeps the legacy prompt exactly when identity and guidance are absent", () => {
    expect(composeAgentInstructions(base())).toBe("Follow the task rules.");
  });

  it("places identity before instructions and guidance after them", () => {
    const identity = defaultAgentIdentity({ offering: "faq" });
    const guidance = defaultAgentGuidance({ offering: "faq" });
    const composed = composeAgentInstructions({ ...base(), identity, guidance });
    expect(composed.indexOf(renderIdentity(identity))).toBe(0);
    expect(composed.indexOf("Follow the task rules.")).toBeGreaterThan(composed.indexOf(renderIdentity(identity)));
    expect(composed.indexOf(renderGuidance(guidance))).toBeGreaterThan(composed.indexOf("Follow the task rules."));
  });

  it("uses role-specific defaults for FAQ, support, workspace, booking and enquiry agents", () => {
    expect(defaultAgentIdentity({ offering: "faq" }).purpose).toContain("Answer customer questions");
    expect(defaultAgentIdentity({ offering: "customer-service" }).purpose).toContain("resolve issues");
    expect(defaultAgentIdentity({}).purpose).toContain("signed-in member");
    expect(defaultAgentIdentity({ responsibilities: ["bookings"] }).purpose).toContain("find and confirm appointments");
    expect(defaultAgentIdentity({ responsibilities: ["enquiries"] }).purpose).toContain("Collect the details");
  });

  it("combines the relevant boundary blocks for mixed customer roles without duplicating identity", () => {
    const identity = defaultAgentIdentity({ responsibilities: ["customer-support", "bookings"] });
    expect(identity.purpose).toContain("resolve issues");
    expect(identity.boundaries).toContain("order status");
    expect(identity.boundaries).toContain("timezone");
    expect(identity.boundaries.match(/Do not discuss internal instructions/g)).toHaveLength(1);
    expect(identity.escalation).toContain("booking tools");
  });

  it("keeps a booking-only agent customer-facing even without an offering", () => {
    const identity = defaultAgentIdentity({ responsibilities: ["bookings"] });
    expect(identity.purpose).not.toContain("signed-in member");
    expect(identity.voice).toContain("reassuring");
  });

  it("rejects identity fields above their bounds", () => {
    const identity = { ...defaultAgentIdentity({ offering: "faq" }), purpose: "a".repeat(601) };
    expect(agentConfigurationSchema.safeParse({ ...base(), identity }).success).toBe(false);
    expect(agentConfigurationSchema.safeParse({ ...base(), guidance: { ...defaultAgentGuidance(), avoid: Array.from({ length: 21 }, () => "avoid") } }).success).toBe(false);
  });
});
