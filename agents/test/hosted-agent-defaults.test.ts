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
});
