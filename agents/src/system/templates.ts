import { z } from "zod";
import { compileAgentSpec } from "../domain/agent-spec";
import type { CreateVersionInput } from "../domain/types";
import { CUSTOMER_SERVICE_HANDOFF_TOOL } from "./hosted-agent-defaults";
import { MODEL_PROVIDER_DEFINITIONS } from "../model/providers";

export interface AgentTemplateDefinition {
  key: string;
  version: number;
  profile: "custom";
  audience: "personal" | "customer_service";
  category: "personal" | "support" | "lead_intake" | "booking";
  name: string;
  description: string;
  instructions: string;
  policy: Record<string, unknown>;
  configuration: Record<string, unknown>;
  requiredConnections: string[];
  requiredCapabilities: string[];
  setupSteps: string[];
  configurableFields: Array<{ key: string; type: "text" | "select"; description: string }>;
  channelCompatibility: string[];
}

const templateSettingsSchema = z.object({
  tone: z.enum(["concise", "balanced", "detailed"]).default("balanced"),
}).strict();

function starterWorkflow(instruction: string): Record<string, unknown> {
  return {
    version: 1,
    entryNodeId: "chat",
    nodes: [
      { id: "chat", type: "deterministic", config: { uiRole: "gateway", operation: "set", path: "workflow.gateway", value: "chat" }, reads: ["input"], writes: ["workflow.gateway"] },
      { id: "agent", type: "model", config: { uiRole: "agent", instruction }, reads: ["input", "knowledge"], writes: ["output"] },
    ],
    edges: [{ from: "chat", to: "agent" }],
    stateSchema: {},
  };
}

const templates: AgentTemplateDefinition[] = [
  {
    key: "website-support",
    version: 1,
    profile: "custom",
    audience: "customer_service",
    category: "support",
    name: "Website support assistant",
    description: "Answer common website questions and explain the next step without claiming actions were completed.",
    instructions: "You are a concise website support assistant. Answer questions using only the available platform context. If a request requires an action you cannot perform, explain where the user can complete it and be clear that you did not perform the action.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 20, maxContextTokens: 4_000, maxModelCalls: 2, maxTotalTokens: 12_000, workflow: starterWorkflow("Answer the website support question using the available context.") },
    requiredConnections: ["website"],
    requiredCapabilities: ["platform.current_time", CUSTOMER_SERVICE_HANDOFF_TOOL],
    setupSteps: ["Review support instructions", "Add website knowledge", "Test responses"],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
    channelCompatibility: ["platform"],
  },
  {
    key: "faq-knowledge",
    version: 1,
    profile: "custom",
    audience: "customer_service",
    category: "support",
    name: "FAQ and knowledge assistant",
    description: "Answer frequently asked questions from the knowledge sources connected to the agent.",
    instructions: "You are a factual FAQ assistant. Prefer the provided knowledge context, state when an answer is not supported by it, and never invent policies, prices, availability, or completed actions.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 24, maxContextTokens: 5_000, maxModelCalls: 2, maxTotalTokens: 12_000, workflow: starterWorkflow("Answer from the connected FAQ and knowledge context; state when it does not support an answer.") },
    requiredConnections: [],
    requiredCapabilities: ["platform.current_time", CUSTOMER_SERVICE_HANDOFF_TOOL],
    setupSteps: ["Add FAQ or website knowledge", "Review answer behavior", "Test responses"],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
    channelCompatibility: ["platform"],
  },
  {
    key: "lead-intake",
    version: 1,
    profile: "custom",
    audience: "customer_service",
    category: "lead_intake",
    name: "Lead intake assistant",
    description: "Collect the information needed for a lead and prepare a clear handoff to a person.",
    instructions: "You are a lead-intake assistant. Ask only for the minimum useful information, summarize what the person shared, and explain that a team member will follow up. Do not claim to create a lead record until a permitted lead tool is available.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 20, maxContextTokens: 4_000, maxModelCalls: 2, maxTotalTokens: 12_000, workflow: starterWorkflow("Collect the minimum lead details, summarize them, and prepare a human handoff.") },
    requiredConnections: [],
    requiredCapabilities: ["platform.current_time", CUSTOMER_SERVICE_HANDOFF_TOOL],
    setupSteps: ["Define intake questions", "Review handoff behavior", "Test a lead conversation"],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
    channelCompatibility: ["platform"],
  },
  {
    key: "booking-intake",
    version: 1,
    profile: "custom",
    audience: "customer_service",
    category: "booking",
    name: "Booking request intake",
    description: "Collect booking-request details and hand them off without claiming a booking was made.",
    instructions: "You are a booking-request intake assistant. Collect the requested service, preferred date or time, name, and contact details. Summarize the request and state that the team must confirm it. Never claim that a booking was created.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 2, maxToolCalls: 2 },
    configuration: { maxContextMessages: 20, maxContextTokens: 4_000, maxModelCalls: 2, maxTotalTokens: 12_000, workflow: starterWorkflow("Collect the booking request details, summarize them, and explain that confirmation is still required.") },
    requiredConnections: [],
    requiredCapabilities: ["platform.current_time", CUSTOMER_SERVICE_HANDOFF_TOOL],
    setupSteps: ["Define booking questions", "Connect booking services later", "Test a request"],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
    channelCompatibility: ["platform"],
  },
  {
    key: "private-research",
    version: 1,
    profile: "custom",
    audience: "personal",
    category: "personal",
    name: "Private research assistant",
    description: "Organize research and summarize information for private workspace use.",
    instructions: "You are a private research assistant. Separate sourced facts from suggestions, ask for missing context, and never claim to have completed an external action.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 3, maxToolCalls: 3 },
    configuration: { maxContextMessages: 24, maxContextTokens: 5_000, maxModelCalls: 3, maxTotalTokens: 12_000, workflow: starterWorkflow("Help with private research using the available knowledge context.") },
    requiredConnections: [],
    requiredCapabilities: ["platform.current_time"],
    setupSteps: ["Add private knowledge", "Review research behavior", "Test a question"],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
    channelCompatibility: ["platform"],
  },
  {
    key: "private-writing",
    version: 1,
    profile: "custom",
    audience: "personal",
    category: "personal",
    name: "Private writing assistant",
    description: "Draft, refine, and organize writing for private workspace use.",
    instructions: "You are a private writing assistant. Preserve the user's intent, identify assumptions, and present drafts for review without claiming to publish or send them.",
    policy: { allowedTools: ["platform.current_time"], maxIterations: 3, maxToolCalls: 3 },
    configuration: { maxContextMessages: 24, maxContextTokens: 5_000, maxModelCalls: 3, maxTotalTokens: 12_000, workflow: starterWorkflow("Draft or refine private writing while preserving the user's intent.") },
    requiredConnections: [],
    requiredCapabilities: ["platform.current_time"],
    setupSteps: ["Review writing instructions", "Add private references", "Test a draft"],
    configurableFields: [{ key: "tone", type: "select", description: "Response tone: concise, balanced, or detailed." }],
    channelCompatibility: ["platform"],
  },
];

export function listAgentTemplates(audience?: "personal" | "customer_service"): AgentTemplateDefinition[] {
  return templates.filter((template) => !audience || template.audience === audience).map((template) => ({
    ...template,
    policy: { ...template.policy },
    configuration: {
      ...template.configuration,
      ...(template.configuration.workflow && typeof template.configuration.workflow === "object" ? {
        workflow: JSON.parse(JSON.stringify(template.configuration.workflow)),
      } : {}),
    },
    requiredConnections: [...template.requiredConnections],
    requiredCapabilities: [...template.requiredCapabilities],
    setupSteps: [...template.setupSteps],
    configurableFields: template.configurableFields.map((field) => ({ ...field })),
    channelCompatibility: [...template.channelCompatibility],
  }));
}

export function getAgentTemplate(key: string): AgentTemplateDefinition | undefined {
  return templates.find((template) => template.key === key);
}

export function templateVersionInput(template: AgentTemplateDefinition, settings: Record<string, unknown>): CreateVersionInput {
  const { tone } = templateSettingsSchema.parse(settings);
  const compiled = compileAgentSpec({
    specVersion: 1,
    identity: { displayName: template.name, purpose: template.description, audience: template.audience },
    behavior: { instructions: `${template.instructions}\nPreferred response tone: ${tone}.` },
    model: {
      version: `template-${template.version}`,
      primary: { provider: "openrouter", model: MODEL_PROVIDER_DEFINITIONS.openrouter.defaultModel },
    },
    runtime: {
      maxIterations: typeof template.policy.maxIterations === "number" ? template.policy.maxIterations : undefined,
      maxToolCalls: typeof template.policy.maxToolCalls === "number" ? template.policy.maxToolCalls : undefined,
      maxContextMessages: typeof template.configuration.maxContextMessages === "number" ? template.configuration.maxContextMessages : undefined,
      maxContextTokens: typeof template.configuration.maxContextTokens === "number" ? template.configuration.maxContextTokens : undefined,
      maxModelCalls: typeof template.configuration.maxModelCalls === "number" ? template.configuration.maxModelCalls : undefined,
      maxTotalTokens: typeof template.configuration.maxTotalTokens === "number" ? template.configuration.maxTotalTokens : undefined,
    },
    capabilities: { allowedTools: template.policy.allowedTools, requiredCapabilities: template.requiredCapabilities },
    knowledge: { requiredConnections: template.requiredConnections },
    workflow: { graph: template.configuration.workflow },
    channels: { allowed: template.channelCompatibility },
  });
  return compiled;
}

export function parseTemplateSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return templateSettingsSchema.parse(settings);
}
