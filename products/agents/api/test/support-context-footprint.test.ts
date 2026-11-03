import { describe, it, expect } from "vitest";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { toolsFor, builtinToolName, publishedToolBindings } from "../src/capabilities/tool-definitions";
import { toolDescriptorPresentation } from "../src/capabilities/tool-descriptors";
import { createToolCatalog } from "../src/capabilities/tool-discovery";
import { capabilityDirectory, capabilityExposure } from "../src/execution/context/capability-directory";
import { sharedProtocolInstructions } from "../src/execution/context/protocol-instructions";
import { buildContext } from "../src/execution/context/context";
import { fixtureContextPolicy } from "./context-fixture";

describe("customer support context footprint", () => {
  it("fits the shared support protocol and discoverable tools inside an explicit8192 input allowance", () => {
    const config = defaultBusinessConfiguration();
    config.capabilities.enquiries = { enabled: true, fields: ["name", "email", "message"] };
    config.tools = ["knowledge.search", "knowledge.read", "enquiry.submit", "enquiry.read", "enquiry.amend", "support.request_handoff_v2", "support.get_status_v2", "channel.request_handoff"];
    const policy = fixtureContextPolicy({ contextWindowTokens: 262144, maxOutputTokens: 4096, safetyTokens: 1024, maxTools: 64, maxRequestBytes: 2097152 });
    const versions = new Map(publishedToolBindings(config).map(binding => [binding.name, binding.version]));
    const tools = toolsFor(config), catalog = createToolCatalog(tools, new Map(tools.map(tool => [tool.function.name, { qualifiedName: `runtime:${tool.function.name}`, revision: "fixture", ...toolDescriptorPresentation(builtinToolName(tool.function.name)!) }])), "3");
    const exposure = capabilityExposure(catalog, [], versions, policy);
    const directory = capabilityDirectory({ catalog, tools: exposure.tools, skills: [], specialists: [], policy });
    const protocol = sharedProtocolInstructions({ delegationEnabled: false, toolCalling: true, discoveryAvailable: true, historyAvailable: false, memoryEnabled: false, delegatedTask: false });
    const customInstructions = ('Use "approved" facts.\n' + "x".repeat(180)).repeat(7).slice(0, 1388);
    const result = buildContext({ modelPolicy: policy, instructions: customInstructions + protocol + "\n" + directory.text, currentInput: "What tools do you have access to? I want to know how you can help me with questions about the business, sending an enquiry and reaching someone from the support team.", tools: exposure.tools,
      requestTime: { receivedAt: "2026-11-03T13:00:00.000Z", referenceTimezone: "UTC", businessTimezone: null } });
    expect(result.estimatedTokens).toBeLessThanOrEqual(8192);
    expect(config.context).toEqual({ mode: "automatic" });
  });
});
