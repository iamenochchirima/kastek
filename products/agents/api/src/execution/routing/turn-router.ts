/** Deterministic turn routing. A route may narrow knowledge and tools, never widen them. */
export type RouteKey = "conversation" | "knowledge" | "catalogue" | "action" | "confirmation" | "complex" | "workspace";
export type PendingActionKind = "booking" | "enquiry" | "tool_review" | "handoff" | "question";
export type KnowledgeRouteMode = "none" | "retrieved" | "pinned" | "agentic";
export type ToolNamespace = "core" | "knowledge" | "action" | "workspace" | "product";
export interface RouteDecision { route: RouteKey; confidence: number; reason: string; pendingAction: PendingActionKind | null }
export interface ContextPolicy {
  maxInputTokens: number; maxKnowledgeTokens: number; maxHistoryTokens: number;
  maxToolSchemaTokens: number; maxToolResultTokens: number; maxProductSchemaTokens: number;
  knowledgeMode: KnowledgeRouteMode; toolNamespaces: readonly ToolNamespace[];
}
export interface RouteDefinition { key: RouteKey; policy: ContextPolicy; instructions: string }
export interface RoutePlan { decision: RouteDecision; definition: RouteDefinition }

const policy = (maxInputTokens: number, maxKnowledgeTokens: number, maxHistoryTokens: number,
  maxToolSchemaTokens: number, maxToolResultTokens: number, maxProductSchemaTokens: number,
  knowledgeMode: KnowledgeRouteMode, toolNamespaces: readonly ToolNamespace[]): ContextPolicy => ({ maxInputTokens, maxKnowledgeTokens,
    maxHistoryTokens, maxToolSchemaTokens, maxToolResultTokens, maxProductSchemaTokens, knowledgeMode, toolNamespaces });

/** Route budgets are policy defaults; tune them here, not in the execution loop. */
export const ROUTE_DEFINITIONS: Readonly<Record<RouteKey, RouteDefinition>> = Object.freeze({
  conversation: { key: "conversation", policy: policy(4_000, 0, 1_500, 1_200, 0, 0, "none", ["core"]),
    instructions: "This is a short conversational turn. Reply directly and do not claim to search or look anything up." },
  knowledge: { key: "knowledge", policy: policy(16_000, 8_000, 6_000, 2_000, 1_000, 2_000, "retrieved", ["knowledge", "product", "workspace", "core"]),
    instructions: "Answer from the supplied knowledge. Do not claim to search unless a knowledge tool was actually called." },
  catalogue: { key: "catalogue", policy: policy(20_000, 10_000, 6_000, 2_000, 1_000, 2_000, "retrieved", ["knowledge", "product", "workspace", "core"]),
    instructions: "Answer from the supplied knowledge. Include the complete requested list when it fits the reply budget." },
  action: { key: "action", policy: policy(8_000, 2_000, 2_000, 2_000, 1_000, 4_000, "retrieved", ["action", "product", "workspace", "core"]),
    instructions: "Continue the requested action. Do not claim an effect without a tool result." },
  confirmation: { key: "confirmation", policy: policy(5_000, 0, 2_000, 1_200, 0, 0, "none", ["action", "core"]),
    instructions: "This is a short confirmation. Answer the pending question or continue the pending action directly. Do not claim to search or look anything up unless a tool was actually called." },
  complex: { key: "complex", policy: policy(24_000, 12_000, 4_000, 3_000, 2_000, 6_000, "retrieved", ["knowledge", "action", "product", "workspace", "core"]),
    instructions: "Address each part of the request. Use the supplied knowledge and do not invent details." },
  workspace: { key: "workspace", policy: policy(24_000, 8_000, 4_000, 4_000, 4_000, 6_000, "retrieved", ["workspace", "knowledge", "action", "product", "core"]),
    instructions: "Continue the workspace task using the available tools and context." },
});

const decision = (route: RouteKey, confidence: number, reason: string, pendingAction: PendingActionKind | null = null): RouteDecision => ({ route, confidence, reason, pendingAction });
const normalized = (text: string): string => text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
const shortConfirmation = /^(?:ok|okay|yes|yeah|yep|sure|go ahead|please do|confirm|do it|sounds good|that works|no|nope|not now|cancel|don't|do not)[.! ]*$/;
const actionRequest = /\b(?:book|booking|appointment|reserve|reservation|enquir(?:y|ies)|inquire|quote|speak to (?:a )?(?:person|human|agent)|human|handoff|hand off|call me|contact me|complaint|complain|escalate|manager|supervisor)\b/;
const catalogueRequest = /\b(?:platter|platters|menu|menus|catalogue|catalog|price list|full list|all (?:the )?(?:items|products|platters|menus|branches|stores)|which (?:branches|stores)|list (?:all|the|your))\b/;
const complexRequest = /\b(?:compare|comparison|versus|vs\.?|difference|and also|plus|multiple)\b/;
const conversation = /^(?:hi|hello|hey|good morning|good afternoon|good evening|ok|okay|cool|great|nice|got it|bye|goodbye)[.! ]*$/;
const acknowledgement = /^(?:(?:ok|okay|cool|great|nice)[\s,!.]+)?(?:thanks|thank you|thx)(?:[\s,!.]+(?:that'?s|that is|this is|so|very))?(?:[\s,!.]+(?:helpful|great|good|perfect|awesome|fine|useful|clear|appreciated))?[.! ]*$/;
const knowledgeRequest = /\b(?:hours?|open|opening|closed|deliver|delivery|policy|refund|return|vegan|vegetarian|gluten|ingredient|allerg|payment|pay|contact|phone|address|email|location|locations|branch|branches|store|stores|price|prices|cost|how|what|where|when|why|who|do you|can i|is there|are there)\b/;

export function routeTurn(input: { text: string; pendingAction?: PendingActionKind | null; lastAssistantQuestion?: boolean; workspace?: boolean }): RouteDecision {
  const text = normalized(input.text), pending = input.pendingAction ?? (input.lastAssistantQuestion ? "question" : null);
  if (!text) return decision("knowledge", 0.5, "empty turn; conservative knowledge fallback", pending);
  if (pending && shortConfirmation.test(text)) return decision("confirmation", 0.98, `short confirmation after pending ${pending}`, pending);
  if (actionRequest.test(text)) return decision("action", 0.92, "explicit action request", pending);
  if (complexRequest.test(text) || (text.match(/\?/g)?.length ?? 0) > 1) return decision("complex", 0.8, "multi-intent or comparison request", pending);
  if (catalogueRequest.test(text)) return decision("catalogue", 0.9, "catalogue or list request", pending);
  if (conversation.test(text) || acknowledgement.test(text)) {
    if (!input.lastAssistantQuestion) return decision("conversation", 0.96, "greeting, thanks or acknowledgement", pending);
  }
  if (knowledgeRequest.test(text) || /\?$/.test(text) || input.lastAssistantQuestion) return decision("knowledge", 0.82, input.lastAssistantQuestion ? "continuation of an assistant question" : "knowledge question", pending);
  if (input.workspace) return decision("workspace", 0.62, "signed-in workspace task", pending);
  return decision("knowledge", 0.55, "ambiguous turn; conservative knowledge fallback", pending);
}

export function routePlan(decision: RouteDecision): RoutePlan {
  const definition = ROUTE_DEFINITIONS[decision.route];
  if (decision.route !== "confirmation") return { decision, definition };
  const actionPending = decision.pendingAction === "booking" || decision.pendingAction === "enquiry" ||
    decision.pendingAction === "tool_review" || decision.pendingAction === "handoff";
  if (actionPending) return { decision, definition: { ...definition,
    policy: { ...definition.policy, toolNamespaces: ["action", "core"] } } };
  // A pending question may be a knowledge offer ("would you like the menu?"), not just a yes/no.
  if (decision.pendingAction === "question") return { decision, definition: { ...definition,
    policy: { ...definition.policy, maxInputTokens: 6_000, maxKnowledgeTokens: 2_000,
      knowledgeMode: "retrieved", toolNamespaces: ["knowledge", "core"] } } };
  return { decision, definition: { ...definition, policy: { ...definition.policy, toolNamespaces: [] } } };
}

/** Resolve the per-agent setting against the route. Pinned is reduced to pinned-core at assembly. */
export function knowledgeModeForRoute(plan: RoutePlan, configured: "auto" | "retrieved" | "agentic" | "pinned"): KnowledgeRouteMode {
  if (plan.definition.policy.knowledgeMode === "none") return "none";
  if (configured === "pinned") return plan.decision.route === "knowledge" || plan.decision.route === "catalogue" ? "pinned" : plan.definition.policy.knowledgeMode;
  // The none check above already turned agentic off for conversation and plain confirmation.
  if (configured === "agentic") return "agentic";
  return plan.definition.policy.knowledgeMode;
}

export function toolNamespace(name: string): ToolNamespace {
  if (name.startsWith("knowledge_")) return "knowledge";
  if (name.startsWith("support_") || name === "channel_request_handoff" || name.startsWith("enquiry_") || name.startsWith("booking_")) return "action";
  if (name.startsWith("history_") || name.startsWith("tools_") || name.startsWith("artifact_") || name.startsWith("sandbox_")) return "workspace";
  return "core";
}

/** External bindings use generated aliases, so authority, not the alias prefix, decides the namespace. */
export function toolAllowed(name: string, namespaces: readonly ToolNamespace[], productAliases?: ReadonlySet<string>): boolean {
  if (productAliases?.has(name)) return namespaces.includes("product");
  return namespaces.includes(toolNamespace(name));
}
