export type AgentAudience = "personal" | "customer_service";

export type AgentRoleKey =
  | "general_assistant"
  | "customer_support"
  | "lead_qualification"
  | "booking_assistant"
  | "internal_helpdesk";

export type AgentRoleOption = {
  key: AgentRoleKey;
  label: string;
  summary: string;
  instruction: string;
};

const roleOptions: Record<AgentRoleKey, AgentRoleOption> = {
  general_assistant: {
    key: "general_assistant",
    label: "General-purpose assistant",
    summary: "A flexible assistant for everyday work.",
    instruction: "Support the user's everyday work and answer requests using the configured knowledge and tools.",
  },
  customer_support: {
    key: "customer_support",
    label: "Customer support",
    summary: "Answer customer questions and guide them to the right next step.",
    instruction: "Answer customer questions, explain approved policies, and guide each customer to the appropriate next step.",
  },
  lead_qualification: {
    key: "lead_qualification",
    label: "Lead qualification",
    summary: "Collect useful lead details and route qualified requests.",
    instruction: "Collect the information needed to qualify a lead, keep the conversation focused, and route qualified requests.",
  },
  booking_assistant: {
    key: "booking_assistant",
    label: "Booking assistant",
    summary: "Help customers find and arrange the right appointment.",
    instruction: "Help customers find suitable availability, collect booking details, and clearly confirm the next step.",
  },
  internal_helpdesk: {
    key: "internal_helpdesk",
    label: "Internal helpdesk",
    summary: "Help the team find answers from approved internal information.",
    instruction: "Help workspace members find answers from approved internal information and identify when a request needs a human owner.",
  },
};

export const customerServiceRoles: AgentRoleOption[] = [
  roleOptions.customer_support,
  roleOptions.lead_qualification,
  roleOptions.booking_assistant,
];

export const personalRoles: AgentRoleOption[] = [
  roleOptions.general_assistant,
  roleOptions.internal_helpdesk,
];

export function getAgentRoleOptions(audience: AgentAudience): AgentRoleOption[] {
  return audience === "customer_service" ? customerServiceRoles : personalRoles;
}

export function getAgentRole(key: string | undefined, audience: AgentAudience): AgentRoleOption {
  const options = getAgentRoleOptions(audience);
  return options.find((option) => option.key === key) ?? options[0] ?? roleOptions.general_assistant;
}

export function knowledgeOutline(audience: AgentAudience, role: AgentRoleKey): string {
  const roleLabel = getAgentRole(role, audience).label;
  return [
    `Business or team: [Add the name and a short description]`,
    `What ${roleLabel.toLowerCase()} can help with: [List the supported requests]`,
    "Approved facts, prices, hours, or service details: [Add current information]",
    "Policies and limits: [Add what the agent may and may not promise]",
    "Escalation rules: [List when the agent must involve a human]",
    "Approved answers: [Add common questions and the exact answer to use]",
  ].join("\n");
}

export function containsKnowledgePlaceholders(value: string): boolean {
  return /\[[^\]]+\]/.test(value);
}

export function generatedAgentInstructions(input: {
  name: string;
  audience: AgentAudience;
  role: AgentRoleKey;
  roleSummary?: string;
  templateInstructions?: string;
  tone?: string;
  responseDetail?: string;
}): string {
  const roleOption = getAgentRole(input.role, input.audience);
  const lines = [
    `You are a user-configured assistant named "${input.name.trim()}".`,
    `Your primary role is to ${roleOption.instruction.charAt(0).toLowerCase()}${roleOption.instruction.slice(1)}`,
    input.roleSummary?.trim() ? `Additional role context: ${input.roleSummary.trim()}` : undefined,
    input.tone ? `Use a ${input.tone} tone.` : undefined,
    input.responseDetail ? `Provide ${input.responseDetail} responses.` : undefined,
    input.audience === "customer_service"
      ? "For customer-facing requests, use approved knowledge, follow the configured service policy, and request human handoff when the policy or workflow requires it."
      : "Use the configured knowledge and tools for this agent; do not claim to be KasiAi or a KasiTek workspace assistant.",
    "Use only trusted instructions, knowledge, and tool results. If the answer is not supported, say what is unknown instead of inventing facts or claiming an action succeeded.",
    input.templateInstructions?.trim(),
  ];
  return lines.filter((line): line is string => Boolean(line?.trim())).join("\n\n");
}

