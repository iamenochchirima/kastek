import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { agentConfigurationSchema, defaultBusinessConfiguration } from "../src/contracts/contracts";
import { orchestrationContracts, orchestrationTools } from "../src/contracts/orchestration";
import { toolsFor, builtinToolEnabled } from "../src/capabilities/tool-definitions";
import { toolDescriptor } from "../src/capabilities/tool-descriptors";
import { validateBuiltinArguments, validateBuiltinResult } from "../src/capabilities/tool-contracts";
import { compilePublishedComposition } from "../src/execution/programs/publication";
import { ADAPTIVE_HARNESS_RELEASE, ADAPTIVE_WORKFLOW_NAME, HARNESS_RELEASE } from "../src/contracts/execution";

function configuration(version: "1" | "4" = "4") {
  const config = defaultBusinessConfiguration(); config.program = { id: "tool-directed", version };
  config.tools = [...orchestrationTools];
  config.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, policy: { maxTasks: 16, maxStalls: 3 },
    bindings: Array.from({ length: 3 }, (_, i) => ({ id: `worker_${i}`, versionId: randomUUID(), sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: 2048, maxActiveMs: 1000 })) };
  return agentConfigurationSchema.parse(config);
}
describe("adaptive orchestration release contracts", () => {
  it("publishes a distinct executable release and nine complete typed tools", () => {
    const config = configuration(); const composition = compilePublishedComposition(config, []);
    expect(composition.runtime).toEqual({ kind: "business", release: ADAPTIVE_HARNESS_RELEASE, workflow: ADAPTIVE_WORKFLOW_NAME });
    expect(toolsFor(config)).toHaveLength(9);
    for (const name of orchestrationTools) {
      expect(builtinToolEnabled(config, name)).toBe(true);
      expect(toolDescriptor(name)).toMatchObject({ name, version: "1", requiredAuthority: ["delegation.execute"] });
      expect(orchestrationContracts[name].input).toBeDefined();
    }
    expect(validateBuiltinArguments("agents.status", {})).toEqual({});
    expect(validateBuiltinResult("agents.status", { children: [] })).toEqual({ children: [] });
  });
  it("keeps the older runtime and narrow roster contracts unchanged", () => {
    const config = defaultBusinessConfiguration();
    expect(compilePublishedComposition(config, []).runtime.release).toBe(HARNESS_RELEASE);
    expect(() => compilePublishedComposition(configuration("1"), [])).toThrowError(expect.objectContaining({ code: "PROGRAM_COMPOSITION_DENIED" }));
    const current = configuration(); current.program.version = "2";
    expect(builtinToolEnabled(current, "agents.start")).toBe(false);
  });
  it("validates resource policy and rejects arbitrary tools or privilege claims", () => {
    const config = configuration();
    expect(() => agentConfigurationSchema.parse({ ...config, tools: ["agents.grant_admin"] })).toThrow();
    expect(() => agentConfigurationSchema.parse({ ...config, capabilities: { ...config.capabilities, delegation: { ...config.capabilities.delegation, maxChildren: 9 } } })).toThrow();
    expect(() => validateBuiltinArguments("agents.start", { requests: [{ bindingId: "worker_0", brief: "Help", grantAdmin: true }] })).toThrow();
    expect(() => validateBuiltinArguments("work.update", { expectedRevision: 0, record: { objective: "Goal", steps: [{ id: "same", title: "A", state: "pending" }, { id: "same", title: "B", state: "pending" }], questions: [], evidenceTaskIds: [] } })).toThrow();
  });
});
