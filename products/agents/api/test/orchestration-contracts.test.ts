import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { agentConfigurationSchema, defaultBusinessConfiguration } from "../src/contracts/contracts";
import { orchestrationContracts, orchestrationTools, orchestrationPolicySchema } from "../src/contracts/orchestration";
import { toolsFor, builtinToolEnabled, publishedToolBindings, assertPublishedTools } from "../src/capabilities/tool-definitions";
import { toolDescriptor } from "../src/capabilities/tool-descriptors";
import { validateBuiltinArguments, validateBuiltinResult } from "../src/capabilities/tool-contracts";
import { compilePublishedComposition } from "../src/execution/programs/publication";
import { SHARED_HARNESS_RELEASE, SHARED_WORKFLOW_NAME } from "../src/contracts/execution";

function configuration(version: "1" | "4" = "4") {
  const config = defaultBusinessConfiguration(); config.program = { id: "tool-directed", version };
  config.tools = [...orchestrationTools];
  config.capabilities.delegation = { enabled: true, maxChildren: 2, maxDepth: 1, policy: { maxTasks: 16, maxStalls: 3 },
    bindings: Array.from({ length: 3 }, (_, i) => ({ id: `worker_${i}`, versionId: randomUUID(), sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: 2048, maxActiveMs: 1000 })) };
  return agentConfigurationSchema.parse(config);
}
describe("adaptive orchestration release contracts", () => {
  it("leaves total specialist starts uncapped unless explicitly configured", () => {
    expect(orchestrationPolicySchema.parse({ maxStalls: 3 })).toEqual({ maxTasks: null, maxStalls: 3 });
    expect(orchestrationPolicySchema.parse({ maxTasks: null, maxStalls: 3 }).maxTasks).toBeNull();
    expect(orchestrationPolicySchema.parse({ maxTasks: 1000, maxStalls: 3 }).maxTasks).toBe(1000);
    for (const maxTasks of [0, -1, Infinity, "unlimited"]) expect(() => orchestrationPolicySchema.parse({ maxTasks, maxStalls: 3 })).toThrow();
  });
  it("publishes a distinct executable release and nine complete typed tools", () => {
    const config = configuration(); const composition = compilePublishedComposition(config, []);
    expect(composition.runtime).toEqual({ kind: "business", release: SHARED_HARNESS_RELEASE, workflow: SHARED_WORKFLOW_NAME });
    expect(toolsFor(config)).toHaveLength(9);
    expect(toolsFor(config).every(tool=>!Object.hasOwn(tool.function.parameters,"$schema"))).toBe(true);
    expect(toolsFor(config).find(tool=>tool.function.name==="agents_start")!.function.parameters.properties.requests.maxItems).toBe(2);
    for (const name of orchestrationTools) {
      expect(builtinToolEnabled(config, name)).toBe(true);
      expect(toolDescriptor(name)).toMatchObject({ name, version: ["agents.start","agents.followup"].includes(name)?"4":name==="agents.result"?"3":["agents.status","work.inspect"].includes(name)?"2":"1", requiredAuthority: ["delegation.execute"] });
      expect(orchestrationContracts[name].input).toBeDefined();
    }
    expect(validateBuiltinArguments("agents.status", {})).toEqual({});
    expect(validateBuiltinResult("agents.status", { children: [] })).toEqual({ children: [] });
  });
  it("retains prior adaptive tool pins while publishing paginated result tools separately",()=>{
    const config=configuration();
    const prior=publishedToolBindings(config,true),current=publishedToolBindings(config);
    expect(prior.find(tool=>tool.name==="agents.status")!.version).toBe("1");
    expect(current.find(tool=>tool.name==="agents.status")!.version).toBe("2");
    expect(prior.find(tool=>tool.name==="agents.status")!.digest).not.toBe(current.find(tool=>tool.name==="agents.status")!.digest);
    expect(()=>assertPublishedTools(config,prior,true)).not.toThrow();
    expect(()=>assertPublishedTools(config,prior)).toThrowError(expect.objectContaining({code:"TOOL_VERSION_UNAVAILABLE"}));
    const legacy=toolsFor(config,[],true).find(tool=>tool.function.name==="agents_status")!;
    expect(legacy.function.parameters.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(legacy.function.parameters.properties).not.toHaveProperty("offset");
    expect(toolDescriptor("agents.status",true)!.outputSchema.properties).not.toHaveProperty("nextOffset");
    expect(toolDescriptor("work.inspect",true)!.version).toBe("1");expect(toolDescriptor("work.inspect")!.version).toBe("2");
    expect(toolsFor(config,[],true).find(tool=>tool.function.name==="work_inspect")!.function.parameters.properties).not.toHaveProperty("instructionSequence");
    expect(toolDescriptor("work.inspect",true)!.outputSchema.properties).not.toHaveProperty("instructionPage");
    const acceptedV2=publishedToolBindings(config,false,new Map([["agents.result","2"]]));
    expect(()=>assertPublishedTools(config,acceptedV2)).not.toThrow();
    expect(toolDescriptor("agents.result",false,"2")!.outputSchema.properties).not.toHaveProperty("metadata");
    expect(toolDescriptor("agents.result",false,"2")!.maxResultBytes).toBe(16384);
    expect(toolDescriptor("agents.result")!.outputSchema.properties).toHaveProperty("metadata");
    expect(toolsFor(config,[],false,new Map([["agents.result","2"]])).find(tool=>tool.function.name==="agents_result")!.function.parameters.properties).not.toHaveProperty("effectOffset");
    const startV1=publishedToolBindings(config,false,new Map([["agents.start","1"]]));
    expect(()=>assertPublishedTools(config,startV1)).not.toThrow();
    const oldStart=toolsFor(config,[],false,new Map([["agents.start","1"]])).find(tool=>tool.function.name==="agents_start")!;
    const newStart=toolsFor(config).find(tool=>tool.function.name==="agents_start")!;
    expect(oldStart.function.parameters.properties.requests.items.properties).not.toHaveProperty("historyReferences");
    expect(newStart.function.parameters.properties.requests.items.properties).toHaveProperty("historyReferences");
    const withHistory={requests:[{bindingId:"worker_0",brief:"Review",historyReferences:[{taskId:randomUUID(),part:"output"}]}]};
    expect(()=>validateBuiltinArguments("agents.start",withHistory,"1")).toThrow();
    expect(()=>validateBuiltinArguments("agents.start",withHistory,"2")).not.toThrow();
    const followup={taskId:randomUUID(),brief:"Review",historyReferences:[{taskId:randomUUID(),part:"output"}]};
    expect(()=>validateBuiltinArguments("agents.followup",followup,"1")).toThrow();
    expect(()=>validateBuiltinArguments("agents.followup",followup,"2")).not.toThrow();
    const withArtifact={requests:[{bindingId:"worker_0",brief:"Review",artifactIds:[randomUUID()]}]};
    expect(()=>validateBuiltinArguments("agents.start",withArtifact,"2")).toThrow();
    expect(()=>validateBuiltinArguments("agents.start",withArtifact,"3")).not.toThrow();
    const followupArtifact={taskId:randomUUID(),brief:"Review",artifactIds:[randomUUID()]};
    expect(()=>validateBuiltinArguments("agents.followup",followupArtifact,"2")).toThrow();
    expect(()=>validateBuiltinArguments("agents.followup",followupArtifact,"3")).not.toThrow();
    const handoffV2=publishedToolBindings(config,false,new Map([["agents.start","2"],["agents.followup","2"]]));
    expect(()=>assertPublishedTools(config,handoffV2)).not.toThrow();
    const handoffV3=publishedToolBindings(config,false,new Map([["agents.start","3"],["agents.followup","3"]]));
    expect(()=>assertPublishedTools(config,handoffV3)).not.toThrow();
    expect(handoffV3.find(tool=>tool.name==="agents.start")!.digest).toBe("c95949132a704df8d85bab1056c8a3dfe77c44f30b3dc87b186c4ed39abb32e0");
    expect(handoffV3.find(tool=>tool.name==="agents.followup")!.digest).toBe("abc62851dd8728655117b1d323f5201fd7c8657297a5167052efdd15f62ed5bc");
    const retainedArtifact={requests:[{bindingId:"worker_0",brief:"Review",artifactReferences:[{taskId:randomUUID(),artifactId:randomUUID()}]}]};
    expect(()=>validateBuiltinArguments("agents.start",retainedArtifact,"3")).toThrow();
    expect(()=>validateBuiltinArguments("agents.start",retainedArtifact,"4")).not.toThrow();
    const retainedFollowup={taskId:randomUUID(),brief:"Review",artifactReferences:[{taskId:randomUUID(),artifactId:randomUUID()}]};
    expect(()=>validateBuiltinArguments("agents.followup",retainedFollowup,"3")).toThrow();
    expect(()=>validateBuiltinArguments("agents.followup",retainedFollowup,"4")).not.toThrow();
    expect(validateBuiltinArguments("work.inspect",{instructionSequence:"0",instructionOffset:0})).toEqual({instructionSequence:"0",instructionOffset:0});
    expect(compilePublishedComposition(config,[],{release:"product-capabilities-v13",workflow:"AgentsBusinessRunV23"}).capabilities).toEqual(expect.arrayContaining(prior.map(tool=>({id:tool.name,version:tool.version,digest:tool.digest}))));
  });
  it("keeps the older runtime and narrow roster contracts unchanged", () => {
    const config = defaultBusinessConfiguration();
    expect(compilePublishedComposition(config, []).runtime.release).toBe(SHARED_HARNESS_RELEASE);
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
