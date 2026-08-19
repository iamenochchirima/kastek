import { describe, expect, it } from "vitest";
import { GENERAL_HOSTED_AGENT_ALLOWED_TOOLS, resolveHostedAgentAllowedTools } from "../src/system/hosted-agent-defaults";

describe("hosted agent default capability pack", () => {
  it("gives general-purpose agents a read-only platform context pack", () => {
    const tools = resolveHostedAgentAllowedTools("general", []);
    expect(tools).toEqual([...GENERAL_HOSTED_AGENT_ALLOWED_TOOLS]);
    expect(tools.some((tool) => tool.includes("_update") || tool.includes("_publish") || tool.includes("_delete"))).toBe(false);
  });

  it("preserves explicit custom policy instead of widening it", () => {
    expect(resolveHostedAgentAllowedTools("custom", ["kasitek.core.contacts_list"])).toEqual(["kasitek.core.contacts_list"]);
    expect(resolveHostedAgentAllowedTools("custom", [])).toEqual([]);
  });
});
