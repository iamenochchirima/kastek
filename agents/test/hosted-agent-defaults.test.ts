import { describe, expect, it } from "vitest";
import { resolveHostedAgentAllowedTools } from "../src/system/hosted-agent-defaults";

describe("hosted agent default capability policy", () => {
  it("keeps ordinary general-purpose agents provider-neutral when no tools are selected", () => {
    const tools = resolveHostedAgentAllowedTools("general", []);
    expect(tools).toEqual([]);
  });

  it("preserves explicit policy without widening it for any hosted profile", () => {
    expect(resolveHostedAgentAllowedTools("general", ["platform.current_time"])).toEqual(["platform.current_time"]);
    expect(resolveHostedAgentAllowedTools("custom", ["kasitek.core.contacts_list"])).toEqual(["kasitek.core.contacts_list"]);
    expect(resolveHostedAgentAllowedTools("custom", [])).toEqual([]);
    expect(resolveHostedAgentAllowedTools("system", [])).toEqual([]);
  });

  it("adds the human handoff capability only to customer-service agents", () => {
    expect(resolveHostedAgentAllowedTools("custom", [], "customer_service")).toEqual(["conversation.request_human"]);
    expect(resolveHostedAgentAllowedTools("custom", ["platform.current_time", "conversation.request_human"], "customer_service")).toEqual([
      "platform.current_time",
      "conversation.request_human",
    ]);
    expect(resolveHostedAgentAllowedTools("custom", [], "personal")).toEqual([]);
    expect(() => resolveHostedAgentAllowedTools("custom", ["conversation.request_human"], "personal")).toThrow("customer-service agent");
  });
});
