import { describe, expect, it } from "vitest";
import { defaultBusinessConfiguration, requestDigest } from "../src/contracts/contracts";
import { assertComposition, compileComposition, resolveProgram, type CompositionDependencies } from "../src/execution/programs/composition";

const faq = { id: "grounded-conversation", version: "1" } as const;
const directed = { id: "tool-directed", version: "1" } as const;
const faqConfiguration = () => ({ ...defaultBusinessConfiguration(), program: faq });
const dependencies: CompositionDependencies = {
  runtime: { release: "fixture-release", workflow: "fixture-workflow" }, tools: [], workflows: [], connectedBindings: [],
};
describe("trusted program composition", () => {
  it("pins the full configuration and context policy, independent of presentation labels", () => {
    const config = faqConfiguration();
    const published = compileComposition(faq, config, dependencies);
    expect(published.context.personalMemory).toBe("disabled");
    expect(published.configurationDigest).toBe(requestDigest(config));
    expect(() => assertComposition(published, compileComposition(faq, config, dependencies))).not.toThrow();
    const changed = compileComposition(faq, { ...config, instructions: "Different instructions" }, dependencies);
    expect(() => assertComposition(published, changed)).toThrowError(expect.objectContaining({ code: "PROGRAM_RELEASE_UNAVAILABLE" }));
  });
  it("rejects model-selected, unknown or incompatible program releases", () => {
    for (const reference of [{ id: "campaign-manager", version: "1" }, { id: "tool-directed", version: "4" }, { ...faq, handler: "unsafe" }]) {
      expect(() => resolveProgram(reference as never)).toThrowError(expect.objectContaining({ code: "PROGRAM_RELEASE_UNAVAILABLE" }));
    }
    expect(() => compileComposition(faq, { ...faqConfiguration(), executionKind: "workspace" }, dependencies))
      .toThrowError(expect.objectContaining({ code: "RUNTIME_UNAVAILABLE" }));
  });
  it("keeps the minimal program from acquiring memory or specialist authority", () => {
    const config = faqConfiguration();
    expect(() => compileComposition(faq, { ...config, memory: { enabled: true } }, dependencies)).toThrowError(expect.objectContaining({ code: "PROGRAM_COMPOSITION_DENIED" }));
    expect(compileComposition(directed, { ...config, program: directed, memory: { enabled: true } }, dependencies).context.personalMemory).toBe("reviewed-principal-v1");
    expect(() => compileComposition(directed, { ...config, program: directed, tools: ["agents.delegate"] }, { ...dependencies,
      tools: [{ name: "agents.delegate", version: "1", digest: "a".repeat(64) }] })).toThrowError(expect.objectContaining({ code: "PROGRAM_COMPOSITION_DENIED" }));
  });
  it("requires exact executable tool closure and rejects silently disabled tools", () => {
    const config = { ...faqConfiguration(), tools: ["knowledge.search"] as const };
    expect(() => compileComposition(faq, { ...config, tools: [...config.tools] }, dependencies)).toThrowError(expect.objectContaining({ code: "PROGRAM_COMPOSITION_DENIED" }));
    const tools = [{ name: "knowledge.search", version: "1", digest: "a".repeat(64) }];
    const published = compileComposition(faq, { ...config, tools: [...config.tools] }, { ...dependencies, tools });
    expect(published.capabilities).toEqual([{ id: "knowledge.search", version: "1", digest: "a".repeat(64) }]);
    expect(() => compileComposition(faq, faqConfiguration(), { ...dependencies, tools })).toThrowError(expect.objectContaining({ code: "PROGRAM_COMPOSITION_DENIED" }));
    expect(() => compileComposition(directed, { ...faqConfiguration(), program: directed, tools: ["memory.search"] }, { ...dependencies,
      tools: [{ name: "memory.search", version: "1", digest: "a".repeat(64) }] })).toThrowError(expect.objectContaining({ code: "PROGRAM_COMPOSITION_DENIED" }));
  });
  it("detects tampered and differently released compositions", () => {
    const published = compileComposition(faq, faqConfiguration(), dependencies);
    expect(() => assertComposition({ ...published, program: { ...published.program, version: "2" } }, published)).toThrow();
    const current = compileComposition(faq, faqConfiguration(), { ...dependencies, runtime: { ...dependencies.runtime, release: "next" } });
    expect(() => assertComposition(published, current)).toThrowError(expect.objectContaining({ code: "PROGRAM_RELEASE_UNAVAILABLE" }));
  });
});
