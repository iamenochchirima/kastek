import { describe, expect, it } from "vitest";
import { ROUTE_DEFINITIONS, knowledgeModeForRoute, routePlan, routeTurn, toolAllowed } from "../src/execution/routing/turn-router";

const routed = (text: string, pendingAction: Parameters<typeof routeTurn>[0]["pendingAction"] = null, lastAssistantQuestion = false) =>
  routeTurn({ text, pendingAction, lastAssistantQuestion });

describe("turn routing", () => {
  it.each([
    ["Hi", null, "conversation"],
    ["thanks", null, "conversation"],
    ["Thanks, that's helpful", null, "conversation"],
    ["okay thanks", null, "conversation"],
    ["thanks, but can you deliver to Soweto?", null, "knowledge"],
    ["okay", null, "conversation"],
    ["Hi, do you deliver to Soweto?", null, "knowledge"],
    ["Hours?", null, "knowledge"],
    ["okay", "booking", "confirmation"],
    ["no", "booking", "confirmation"],
    ["okay, but can you deliver?", null, "knowledge"],
    ["I have a complaint", null, "action"],
    ["I want to book a table for Saturday.", null, "action"],
    ["I want to submit an enquiry.", null, "action"],
    ["I need to speak to a person.", null, "action"],
    ["What platters do you have?", null, "catalogue"],
    ["What menus do you have?", null, "catalogue"],
    ["Which branches do you have?", null, "catalogue"],
    ["Compare the platters and lunch boxes.", null, "complex"],
    ["I need a platter for 20 people and also want to know delivery and payment.", null, "complex"],
    ["hmm", null, "knowledge"],
  ] as const)("routes %s to %s", (text, pending, expected) => {
    expect(routed(text, pending).route).toBe(expected);
  });

  it("treats a short reply to an assistant question as confirmation but a new request as knowledge", () => {
    expect(routed("okay", null, true).route).toBe("confirmation");
    expect(routed("okay, but can you deliver?", null, true).route).toBe("knowledge");
  });

  it("confirmation keeps knowledge tools for a pending question and action tools for a pending action", () => {
    expect(routePlan(routed("okay", "question")).definition.policy).toMatchObject({ knowledgeMode: "retrieved", toolNamespaces: ["knowledge", "core"] });
    expect(routePlan(routed("okay", "question")).definition.policy.maxInputTokens).toBe(6_000);
    expect(routePlan(routed("okay", "booking")).definition.policy.toolNamespaces).toEqual(["action", "core"]);
  });

  it("resolves route knowledge modes without widening a pinned or agentic choice", () => {
    const conversation = routePlan(routed("Hi"));
    const knowledge = routePlan(routed("What are your opening hours?"));
    expect(knowledgeModeForRoute(conversation, "pinned")).toBe("none");
    expect(knowledgeModeForRoute(knowledge, "pinned")).toBe("pinned");
    expect(knowledgeModeForRoute(knowledge, "auto")).toBe("retrieved");
    expect(knowledgeModeForRoute(routePlan(routed("I want to book a table")), "pinned")).toBe("retrieved");
    expect(knowledgeModeForRoute(conversation, "agentic")).toBe("none");
    expect(knowledgeModeForRoute(routePlan(routed("Compare the platters and lunch boxes.")), "agentic")).toBe("agentic");
  });

  it("keeps route tools inside the configured route namespaces", () => {
    const knowledge = ROUTE_DEFINITIONS.knowledge.policy.toolNamespaces;
    const conversation = ROUTE_DEFINITIONS.conversation.policy.toolNamespaces;
    const action = ROUTE_DEFINITIONS.action.policy.toolNamespaces;
    expect(toolAllowed("knowledge_search", knowledge)).toBe(true);
    expect(toolAllowed("support_request_handoff", knowledge)).toBe(false);
    expect(toolAllowed("knowledge_search", conversation)).toBe(false);
    expect(toolAllowed("history_search", conversation)).toBe(false);
    expect(toolAllowed("history_search", knowledge)).toBe(true);
    expect(toolAllowed("tasks_inspect", conversation)).toBe(true);
    expect(toolAllowed("records_search", knowledge)).toBe(true);
    expect(toolAllowed("memory_read", knowledge)).toBe(true);
    expect(toolAllowed("support_request_handoff", action)).toBe(true);
  });

  it("names product tools from binding authority, not their generated alias", () => {
    const product = new Set(["t_11111111111111111111111111111111", "t_22222222222222222222222222222222"]);
    expect(toolAllowed("t_11111111111111111111111111111111", ROUTE_DEFINITIONS.conversation.policy.toolNamespaces, product)).toBe(false);
    expect(toolAllowed("t_11111111111111111111111111111111", ROUTE_DEFINITIONS.knowledge.policy.toolNamespaces, product)).toBe(true);
    expect(toolAllowed("t_11111111111111111111111111111111", ROUTE_DEFINITIONS.action.policy.toolNamespaces, product)).toBe(true);
    expect(toolAllowed("knowledge_search", ROUTE_DEFINITIONS.knowledge.policy.toolNamespaces, product)).toBe(true);
  });

  it("reserves no product schema tokens for conversation", () => {
    expect(ROUTE_DEFINITIONS.conversation.policy.maxProductSchemaTokens).toBe(0);
    expect(ROUTE_DEFINITIONS.knowledge.policy.maxProductSchemaTokens).toBeGreaterThan(0);
    expect(ROUTE_DEFINITIONS.knowledge.policy.maxProductSchemaTokens)
      .toBeLessThanOrEqual(ROUTE_DEFINITIONS.knowledge.policy.maxInputTokens);
    expect(ROUTE_DEFINITIONS.action.policy.maxProductSchemaTokens)
      .toBeLessThanOrEqual(ROUTE_DEFINITIONS.action.policy.maxInputTokens);
  });

  it("keeps every route input budget positive and ordered below the workspace ceiling", () => {
    for (const definition of Object.values(ROUTE_DEFINITIONS)) {
      expect(definition.policy.maxInputTokens).toBeGreaterThan(0);
      expect(definition.policy.maxKnowledgeTokens).toBeLessThanOrEqual(definition.policy.maxInputTokens);
      expect(definition.policy.maxInputTokens).toBeLessThanOrEqual(24_000);
    }
    expect(ROUTE_DEFINITIONS.conversation.policy.maxInputTokens).toBe(4_000);
  });
});
