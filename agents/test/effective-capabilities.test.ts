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
    expect(snapshot.model.summary).toContain("Work calendar -> calendar.read");
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
    const retry = createEffectiveCapabilitySnapshot({
      scope: { ...scope, runId: "run-2" },
      tools: [tool("a"), tool("b")],
      grantedTools: ["a", "b"],
    });
    expect(first.digest).toBe(retry.digest);
  });

  it("admits provider bundles only when the connector is ready and policy grants the action", () => {
    const calendarNames = [
      "kasitek.calendar.list",
      "kasitek.calendar.create",
      "kasitek.calendar.update",
      "kasitek.calendar.delete",
    ] as const;
    const calendarTools = calendarNames.map((name) => tool(name, {
      kind: "connector_tool",
      source: { kind: "connector", id: "calendar" },
      toolsetIds: ["connector.internal.calendar", "connector.google.calendar", "connector.apple.tools"],
      provider: { id: "calendar", name: "Calendar" },
    }));
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [...calendarTools, tool("kasitek.gmail.search", {
        kind: "connector_tool",
        source: { kind: "connector", id: "google.gmail" },
        toolsetIds: ["connector.google.gmail"],
        provider: { id: "google", name: "Google" },
      })],
      grantedTools: [...calendarNames, "kasitek.gmail.search"],
      connections: [
        { id: "google.calendar", displayName: "Google Calendar", providerId: "google", status: "connected", capabilityIds: [...calendarNames] },
        { id: "google.gmail", displayName: "Gmail", providerId: "google", status: "not_granted", capabilityIds: ["kasitek.gmail.search"] },
      ],
    });

    expect(snapshot.execution.callableToolNames).toEqual([...calendarNames].sort());
    expect(snapshot.execution.connections.find((connection) => connection.id === "google.calendar")).toMatchObject({
      status: "connected",
      usableCapabilityIds: [...calendarNames].sort(),
    });
    expect(snapshot.execution.connections.find((connection) => connection.id === "google.gmail")).toMatchObject({
      status: "not_granted",
      usableCapabilityIds: [],
    });
    expect(snapshot.studio.unavailable).toEqual(expect.arrayContaining([
      { id: "kasitek.gmail.search", kind: "tool", reason: "not_granted" },
      { id: "google.gmail", kind: "connection", reason: "not_granted" },
    ]));
    expect(snapshot.model.summary).toContain("Google Calendar -> kasitek.calendar.create, kasitek.calendar.delete, kasitek.calendar.list, kasitek.calendar.update");
    expect(snapshot.model.summary).not.toContain("Gmail ->");
  });

  it("does not expose an external tool when its connector is connected in the catalog but not ready", () => {
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [tool("kasitek.gmail.search", {
        kind: "connector_tool",
        source: { kind: "connector", id: "google.gmail" },
        toolsetIds: ["connector.google.gmail"],
      })],
      grantedTools: ["kasitek.gmail.search"],
      connections: [{ id: "google.gmail", displayName: "Gmail", status: "not_configured", capabilityIds: ["kasitek.gmail.search"] }],
    });

    expect(snapshot.execution.callableToolNames).toEqual([]);
    expect(snapshot.execution.unavailableTools).toContainEqual(expect.objectContaining({ name: "kasitek.gmail.search", reason: "not_configured" }));
    expect(snapshot.model.callableTools).toEqual([]);
  });

  it("changes the digest when the scoped registry generation changes", () => {
    const first = createEffectiveCapabilitySnapshot({
      scope,
      registryGeneration: 1,
      tools: [tool("calendar.read")],
      grantedTools: ["calendar.read"],
    });
    const second = createEffectiveCapabilitySnapshot({
      scope,
      registryGeneration: 2,
      tools: [tool("calendar.read")],
      grantedTools: ["calendar.read"],
    });
    expect(first.registryGeneration).toBe("1");
    expect(second.registryGeneration).toBe("2");
    expect(first.digest).not.toBe(second.digest);
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
    expect(system).toContain("current connected records such as calendar events");
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

  it("always includes the capability contract with the admitted tool projection", () => {
    const snapshot = createEffectiveCapabilitySnapshot({
      scope,
      tools: [tool("calendar.read")],
      grantedTools: ["calendar.read"],
      message: "What tools can you use?",
    });
    const input = {
      instructions: "Answer clearly.",
      scope,
      currentMessage: "What tools can you use?",
      recentMessages: [],
      authorizedTools: [tool("calendar.read")],
      capabilitySnapshot: snapshot,
      budget: { maxContextTokens: 20_000, reservedOutputTokens: 0 },
    } as const;
    const context = buildAgentContext(input);
    const system = String(context.messages[0]?.content);

    expect(system).toContain("Capability awareness contract (runtime-owned)");
    expect(system).toContain("Agent capability discovery v1.0.0");
    expect(context.tools.map((entry) => entry.name)).toEqual(["calendar.read"]);
    expect(context.capabilitySnapshotDigest).toBe(snapshot.digest);
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
