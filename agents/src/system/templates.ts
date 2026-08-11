import type { CreateVersionInput } from "../domain/types";

export interface AgentTemplateDefinition {
  key: string;
  version: number;
  name: string;
  description: string;
  instructions: string;
  policy: Record<string, unknown>;
  configuration: Record<string, unknown>;
  requiredConnections: string[];
  configurableFields: Array<{ key: string; type: "text" | "select"; description: string }>;
}

const templates: AgentTemplateDefinition[] = [
  {
    key: "website-support",
    version: 1,
    name: "Website support assistant",
    description: "Answer common website questions and explain the next step without claiming actions were completed.",
    instructions: "You are a concise website support assistant. Answer questions using only the available platform context. If a request requires an action you cannot perform, explain where the user can complete it and be clear that you did not perform the action.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 20, maxContextTokens: 4_000, maxModelCalls: 2, maxTotalTokens: 1_000 },
    requiredConnections: ["website"],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
  },
  {
    key: "faq-knowledge",
    version: 1,
    name: "FAQ and knowledge assistant",
    description: "Answer frequently asked questions from the knowledge sources connected to the agent.",
    instructions: "You are a factual FAQ assistant. Prefer the provided knowledge context, state when an answer is not supported by it, and never invent policies, prices, availability, or completed actions.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 24, maxContextTokens: 5_000, maxModelCalls: 2, maxTotalTokens: 1_200 },
    requiredConnections: [],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
  },
  {
    key: "lead-intake",
    version: 1,
    name: "Lead intake assistant",
    description: "Collect the information needed for a lead and prepare a clear handoff to a person.",
    instructions: "You are a lead-intake assistant. Ask only for the minimum useful information, summarize what the person shared, and explain that a team member will follow up. Do not claim to create a lead record until a permitted lead tool is available.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 20, maxContextTokens: 4_000, maxModelCalls: 2, maxTotalTokens: 1_000 },
    requiredConnections: [],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
  },
  {
    key: "booking-intake",
    version: 1,
    name: "Booking request intake",
    description: "Collect booking-request details and hand them off without claiming a booking was made.",
    instructions: "You are a booking-request intake assistant. Collect the requested service, preferred date or time, name, and contact details. Summarize the request and state that the team must confirm it. Never claim that a booking was created.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 20, maxContextTokens: 4_000, maxModelCalls: 2, maxTotalTokens: 1_000 },
    requiredConnections: [],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
  },
];

export function listAgentTemplates(): AgentTemplateDefinition[] {
  return templates.map((template) => ({
    ...template,
    policy: { ...template.policy },
    configuration: { ...template.configuration },
    requiredConnections: [...template.requiredConnections],
    configurableFields: template.configurableFields.map((field) => ({ ...field })),
  }));
}

export function getAgentTemplate(key: string): AgentTemplateDefinition | undefined {
  return templates.find((template) => template.key === key);
}

export function templateVersionInput(template: AgentTemplateDefinition, settings: Record<string, unknown>): CreateVersionInput {
  const tone = typeof settings.tone === "string" && ["concise", "balanced", "detailed"].includes(settings.tone)
    ? settings.tone
    : "balanced";
  return {
    instructions: `${template.instructions}\nPreferred response tone: ${tone}.`,
    configuration: { ...template.configuration },
    policy: { ...template.policy },
  };
}
