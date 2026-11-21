import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultBusinessConfiguration, type AgentConfiguration } from "../src/contracts/contracts";
import { builtinToolEnabled, publishedToolBindings } from "../src/capabilities/tools";
import { operationsForConfiguration } from "../src/platform/access/grant-operations";

const toolNames = (configuration: AgentConfiguration) => publishedToolBindings(configuration).map(binding => binding.name);

describe("capability authorization surface", () => {
  it("publishes knowledge operations only when a source and the tools are selected", () => {
    const enabled = defaultBusinessConfiguration();
    enabled.sourceRevisionIds = [randomUUID()];
    enabled.tools = [...enabled.tools, "knowledge.search", "knowledge.read"];
    expect(toolNames(enabled)).toEqual(expect.arrayContaining(["knowledge.search", "knowledge.read"]));
    const disabled = { ...enabled, sourceRevisionIds: [], tools: enabled.tools.filter(name => !name.startsWith("knowledge.")) };
    expect(toolNames(disabled)).not.toEqual(expect.arrayContaining(["knowledge.search"]));
    expect(builtinToolEnabled(disabled, "knowledge.search")).toBe(false);
  });

  it("publishes memory operations and grants only when memory is enabled", () => {
    const enabled = defaultBusinessConfiguration();
    enabled.memory = { enabled: true };
    enabled.tools = [...enabled.tools, "memory.search"];
    expect(toolNames(enabled)).toEqual(expect.arrayContaining(["memory.search"]));
    expect(operationsForConfiguration(enabled)).toEqual(expect.arrayContaining(["memory.read", "memory.propose"]));
    const disabled = { ...enabled, memory: { enabled: false }, tools: enabled.tools.filter(name => !name.startsWith("memory.")) };
    expect(toolNames(disabled)).not.toEqual(expect.arrayContaining(["memory.search"]));
    expect(operationsForConfiguration(disabled)).not.toEqual(expect.arrayContaining(["memory.read", "memory.propose"]));
    expect(builtinToolEnabled(disabled, "memory.search")).toBe(false);
  });

  it("publishes skill operations and the skill grant only with selected skills", () => {
    const enabled = defaultBusinessConfiguration();
    enabled.skillIds = [randomUUID()];
    expect(toolNames(enabled)).toEqual(expect.arrayContaining(["skills.activate", "skills.read"]));
    expect(operationsForConfiguration(enabled)).toContain("skill.read");
    const disabled = { ...enabled, skillIds: [] };
    expect(toolNames(disabled)).not.toEqual(expect.arrayContaining(["skills.activate"]));
    expect(operationsForConfiguration(disabled)).not.toContain("skill.read");
    expect(builtinToolEnabled(disabled, "skills.activate")).toBe(false);
  });

  it("publishes delegation operations and the delegation grant only when enabled", () => {
    const enabled = defaultBusinessConfiguration();
    enabled.program = { id: "tool-directed", version: "4" };
    enabled.tools = [...enabled.tools, "agents.delegate"];
    enabled.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, bindings: [], roster: "open" };
    expect(toolNames(enabled)).toContain("agents.delegate");
    expect(operationsForConfiguration(enabled)).toContain("delegation.execute");
    const disabled = { ...enabled, tools: enabled.tools.filter(name => name !== "agents.delegate"),
      capabilities: { ...enabled.capabilities, delegation: { enabled: false as const } } };
    expect(toolNames(disabled)).not.toContain("agents.delegate");
    expect(operationsForConfiguration(disabled)).not.toContain("delegation.execute");
    expect(builtinToolEnabled(disabled, "agents.delegate")).toBe(false);
  });

  it("publishes workflow delivery and artifact grants only when workflows are enabled", () => {
    const enabled = defaultBusinessConfiguration();
    enabled.capabilities.workflows = { enabled: true, profileId: "report-delivery-v1", connectionId: randomUUID(),
      reportArtifactName: "report.md", title: "Report" };
    expect(toolNames(enabled)).toContain("report.deliver");
    expect(operationsForConfiguration(enabled)).toEqual(expect.arrayContaining(["effect.deliver", "artifact.read", "artifact.write"]));
    const disabled = { ...enabled, capabilities: { ...enabled.capabilities, workflows: { enabled: false as const } } };
    expect(toolNames(disabled)).not.toContain("report.deliver");
    expect(operationsForConfiguration(disabled)).not.toContain("effect.deliver");
  });

  it("publishes handoff and sandbox grants only with their tools and capability", () => {
    const enabled = defaultBusinessConfiguration();
    enabled.tools = [...enabled.tools, "channel.request_handoff"];
    enabled.capabilities.sandbox = { enabled: true, profileId: "python-analysis-v1" };
    enabled.tools = [...enabled.tools, "sandbox.analyze"];
    expect(toolNames(enabled)).toEqual(expect.arrayContaining(["channel.request_handoff", "sandbox.analyze"]));
    expect(operationsForConfiguration(enabled)).toEqual(expect.arrayContaining(["channel.handoff", "sandbox.execute"]));
    const disabled = { ...enabled,
      tools: enabled.tools.filter(name => name !== "channel.request_handoff" && name !== "sandbox.analyze"),
      capabilities: { ...enabled.capabilities, sandbox: { enabled: false as const } } };
    expect(toolNames(disabled)).not.toEqual(expect.arrayContaining(["channel.request_handoff", "sandbox.analyze"]));
    expect(operationsForConfiguration(disabled)).not.toEqual(expect.arrayContaining(["channel.handoff", "sandbox.execute"]));
    expect(builtinToolEnabled(disabled, "channel.request_handoff")).toBe(false);
  });
});
