import { describe, expect, it } from "vitest";
import { createEffectiveCapabilitySnapshot } from "../src/runtime/effective-capabilities";
import { classifyAgentIntent, shouldFailClosedWithoutEvidence } from "../src/runtime/grounding";
import { buildAgentContext } from "../src/runtime/context";
import { KASIAI_PLATFORM_GUIDANCE_EXTENSION } from "../src/system/kasiai-platform-guidance";
import type { ToolDefinition } from "../src/tools/types";
import type { ExecutionScope } from "../src/runtime/execution-scope";

const scope: ExecutionScope = {
  organizationId: "org-1",
  installationId: "installation-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  runId: "run-1",
  correlationId: "corr-1",
  capabilityGrants: ["calendar.read"],
};

function tool(name: string, catalog?: ToolDefinition["catalog"]): Omit<ToolDefinition, "handler"> {
  return {
    name,
    version: "1.0.0",
    description: `${name} description`,
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1_000,
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    ...(catalog ? { catalog } : {}),
  };
}

describe("effective capability discovery", () => {
  it("projects grants, readiness reasons, and progressive skills from one immutable snapshot", () => {
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [
        tool("calendar.read", { kind: "connector_tool", source: { kind: "connector", id: "calendar" }, provider: { id: "calendar", name: "Calendar" } }),
        tool("calendar.write"),
      ],
      grantedTools: new Set(["calendar.read"]),
      connections: [{ id: "calendar", displayName: "Work calendar", status: "connected", capabilityIds: ["calendar.read"] }],
      skills: [
        {
          id: "booking",
          version: "1.0.0",
          name: "Booking",
          published: true,
          pinned: true,
          requiredCapabilityIds: ["calendar.read"],
          instructions: "Use the calendar read flow.",
          matching: { keywords: ["booking"] },
        },
        {
          id: "blocked",
          version: "1.0.0",
          name: "Blocked",
          published: true,
          pinned: true,
          requiredCapabilityIds: ["calendar.write"],
          instructions: "Must not load.",
          matching: { keywords: ["booking"] },
        },
      ],
      message: "Help with booking",
    });

    expect(snapshot.execution.callableToolNames).toEqual(["calendar.read"]);
    expect(snapshot.studio.unavailable).toEqual(expect.arrayContaining([
      { id: "calendar.write", kind: "tool", reason: "not_granted" },
      { id: "blocked", kind: "skill", reason: "dependency_not_ready" },
    ]));
    expect(snapshot.model.callableTools.map((entry) => entry.name)).toEqual(["calendar.read"]);
    expect(snapshot.model.skillIndex.find((entry) => entry.id === "booking")).toMatchObject({ readiness: "ready" });
    expect(snapshot.model.skillIndex.find((entry) => entry.id === "booking")).not.toHaveProperty("instructions");
    expect(snapshot.model.loadedSkills.map((entry) => entry.id)).toEqual(["booking"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the digest stable when registry and grants arrive in a different order", () => {
    const first = createEffectiveCapabilitySnapshot({
      scope,
      tools: [tool("b"), tool("a")],
      grantedTools: ["a", "b"],
    });
    const second = createEffectiveCapabilitySnapshot({
      scope,
      tools: [tool("a"), tool("b")],
      grantedTools: ["b", "a"],
    });
    expect(first.digest).toBe(second.digest);
  });

  it("reports grants for tools missing from the runtime registry without exposing a callable schema", () => {
    const snapshot = createEffectiveCapabilitySnapshot({ scope, tools: [], grantedTools: ["missing.tool"] });
    expect(snapshot.studio.unavailable).toContainEqual({ id: "missing.tool", kind: "tool", reason: "not_registered" });
    expect(snapshot.model.callableTools).toEqual([]);
  });

  it("routes capability questions away from the evidence-only grounding fallback", () => {
    expect(classifyAgentIntent("What are the things you can do for me?")).toBe("capability_request");
    expect(classifyAgentIntent("What other things can you help with, I want a full list")).toBe("capability_request");
    expect(classifyAgentIntent("What is the refund policy?")).toBe("knowledge_request");
    expect(classifyAgentIntent("Please publish this post")).toBe("effect_request");
    expect(shouldFailClosedWithoutEvidence({
      message: "What are the things you can do for me?",
      agentAudience: "customer_service",
      evidenceCount: 0,
    })).toBe(false);
    expect(shouldFailClosedWithoutEvidence({
      message: "What is the refund policy?",
      agentAudience: "customer_service",
      evidenceCount: 0,
    })).toBe(true);
  });

  it("assembles the capability contract, compact index, generic skill, and only callable schemas", () => {
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [tool("calendar.read"), tool("calendar.write")],
      grantedTools: ["calendar.read"],
      message: "What tools can you use?",
    });
    const context = buildAgentContext({
      instructions: "Answer clearly.",
      scope,
      currentMessage: "What tools can you use?",
      recentMessages: [],
      authorizedTools: [tool("calendar.read"), tool("calendar.write")],
      capabilitySnapshot: snapshot,
      budget: { maxContextTokens: 20_000, reservedOutputTokens: 0 },
    });
    const system = String(context.messages[0]?.content);
    expect(context.capabilitySnapshotDigest).toBe(snapshot.digest);
    expect(system).toContain("Capability awareness contract (runtime-owned)");
    expect(system).toContain("Agent capability discovery v1.0.0");
    expect(system).toContain("Callable tools: calendar.read");
    expect(context.tools.map((entry) => entry.name)).toContain("calendar.read");
    expect(context.tools.map((entry) => entry.name)).not.toContain("calendar.write");
  });

  it("layers the protected KasiAi extension without changing the generic snapshot", () => {
    const snapshot = createEffectiveCapabilitySnapshot({ scope, tools: [], grantedTools: [] });
    const context = buildAgentContext({
      instructions: "You are KasiAi.",
      systemExtensions: [KASIAI_PLATFORM_GUIDANCE_EXTENSION],
      scope,
      currentMessage: "Hello",
      recentMessages: [],
      authorizedTools: [],
      capabilitySnapshot: snapshot,
      budget: { maxContextTokens: 20_000, reservedOutputTokens: 0 },
    });
    expect(String(context.messages[0]?.content)).toContain("Protected system extension kasiai-platform-guidance v1.0.0");
    expect(snapshot.model.summary).toContain("Capability projection");
  });

  it("does not trust an optimistic skill dependency flag over missing grants", () => {
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [tool("calendar.read")],
      grantedTools: [],
      skills: [{
        id: "booking",
        version: "1.0.0",
        name: "Booking",
        published: true,
        pinned: true,
        dependencyReady: true,
        requiredCapabilityIds: ["calendar.read"],
        instructions: "Use the calendar flow.",
        matching: { keywords: ["booking"] },
      }],
      message: "Help with booking",
    });
    expect(snapshot.model.skillIndex).toContainEqual(expect.objectContaining({ id: "booking", readiness: "unavailable", reason: "dependency_not_ready" }));
    expect(snapshot.model.loadedSkills).toEqual([]);
  });

  it("does not treat a catalogue descriptor as a registered executable dependency", () => {
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [],
      descriptors: [{
        id: "calendar.read",
        name: "Calendar read",
        description: "Catalogue metadata only",
        kind: "connector_tool",
        source: { kind: "connector", id: "calendar", version: "1.0.0", trust: "platform" },
        version: "1.0.0",
        category: "calendar",
        tags: [],
        toolsetIds: [],
        runtime: { execution: "native", requiredScopes: [], credentialRequirements: [] },
      }],
      grantedTools: ["calendar.read"],
      skills: [{
        id: "booking",
        version: "1.0.0",
        name: "Booking",
        published: true,
        pinned: true,
        requiredCapabilityIds: ["calendar.read"],
        instructions: "Use the calendar flow.",
        matching: { keywords: ["booking"] },
      }],
      message: "Help with booking",
    });
    expect(snapshot.studio.unavailable).toContainEqual({ id: "booking", kind: "skill", reason: "dependency_not_found" });
  });
});
