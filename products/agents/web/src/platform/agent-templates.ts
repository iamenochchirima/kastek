import type { CustomerSetup } from "./api";

export type AgentJob = CustomerSetup["responsibilities"][number];

export type AgentTemplate = {
  id: AgentJob;
  label: string;
  description: string;
  knowledge: boolean;
};

/** Templates are starting points, not grants. The API derives the default tools and identity. */
export const agentTemplates: readonly AgentTemplate[] = [
  { id: "answer-questions", label: "Answer questions", description: "Answers from your knowledge and business information.", knowledge: true },
  { id: "customer-support", label: "Customer support", description: "Handles requests and hands over to a person.", knowledge: true },
  { id: "bookings", label: "Bookings", description: "Collects appointment requests.", knowledge: false },
  { id: "enquiries", label: "Enquiries", description: "Captures customer details and requests.", knowledge: false },
] as const;

export const defaultJob: AgentJob = "answer-questions";

export function needsKnowledge(jobs: readonly AgentJob[]): boolean {
  return jobs.some(job => agentTemplates.find(template => template.id === job)?.knowledge);
}

/** Minimal setup accepted by POST /agents: the business name is the agent name until edited. */
export function setupFor(name: string, jobs: readonly AgentJob[]): CustomerSetup {
  const agentName = name.trim().slice(0, 120);
  return {
    business: { name: agentName, website: "", description: "" },
    responsibilities: [...new Set(jobs)],
    channels: [],
    behaviour: { agentName, language: "English", tone: "friendly", handoffInstructions: "" },
  };
}
