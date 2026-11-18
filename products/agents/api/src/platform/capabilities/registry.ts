import { knowledgeCapability } from "../knowledge/capability";
import { memoryCapability } from "../memory/capability";

export type CapabilityId = "tools" | "knowledge" | "memory" | "handoff" | "delegation" | "workflows" | "skills"
  | "schedules" | "code" | "browser";

export interface CapabilityDefinition {
  id: CapabilityId;
  title: string;
  optional: boolean;
  availability: "available" | "deferred";
  setup?: string;
  summary: string;
}

/**
 * Registered agent capabilities. Deferred entries are listed so setup can show them without
 * accepting configuration until their runtime exists.
 */
export const capabilityRegistry: readonly CapabilityDefinition[] = [
  { id: "tools", title: "Tools", optional: true, availability: "available", summary: "Discover and invoke assigned operations." },
  { id: "knowledge", title: knowledgeCapability.title, optional: true, availability: "available",
    setup: knowledgeCapability.basePath, summary: knowledgeCapability.summary },
  { id: "memory", title: memoryCapability.title, optional: true, availability: "available",
    setup: `${memoryCapability.agentBasePath}/memory`, summary: memoryCapability.summary },
  { id: "handoff", title: "Human handoff", optional: true, availability: "available", summary: "Request human help and track takeover." },
  { id: "delegation", title: "Delegation", optional: true, availability: "available", summary: "Start child runs or delegate to named agents." },
  { id: "workflows", title: "Workflows", optional: true, availability: "available", summary: "Run assigned procedures with durable progress." },
  { id: "skills", title: "Skills", optional: true, availability: "available", summary: "Load assigned instructions and resources." },
  { id: "schedules", title: "Schedules", optional: true, availability: "deferred", summary: "Start runs at configured times." },
  { id: "code", title: "Code execution", optional: true, availability: "deferred", summary: "Run code in an isolated environment." },
  { id: "browser", title: "Browser use", optional: true, availability: "deferred", summary: "Interact with websites through a browser." },
] as const;

export function capability(id: CapabilityId): CapabilityDefinition {
  const found = capabilityRegistry.find(entry => entry.id === id);
  if (!found) throw new Error(`Unknown capability: ${id}`);
  return found;
}
