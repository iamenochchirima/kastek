const DRAFT_VERSION = 1;
const DRAFT_PREFIX = "kasitek:agent-creation-draft";

export type AgentCreationDraftKind = "general" | "custom";
export type AgentCreationDraftAudience = "personal" | "customer_service";

export type AgentCreationDraftSummary = {
  key: string;
  kind: AgentCreationDraftKind;
  audience: AgentCreationDraftAudience;
  templateKey?: string;
  name?: string;
  step?: number;
  updatedAt: string;
};

export function agentCreationDraftKey(
  kind: AgentCreationDraftKind,
  audience: AgentCreationDraftAudience,
  userId?: string,
  templateKey?: string,
): string {
  const owner = userId?.trim() || "anonymous";
  const template = templateKey?.trim() || "default";
  return `${DRAFT_PREFIX}:v${DRAFT_VERSION}:${owner}:${kind}:${audience}:${template}`;
}

export function readAgentCreationDraft<T>(key: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if ((value as { version?: unknown }).version !== DRAFT_VERSION) return null;
    return value as T;
  } catch {
    return null;
  }
}

export function writeAgentCreationDraft<T extends object>(key: string, draft: T): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ version: DRAFT_VERSION, updatedAt: new Date().toISOString(), ...draft }));
  } catch {
    // Private browsing, blocked storage, and quota limits should not break creation.
  }
}

export function clearAgentCreationDraft(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures; successful creation should still complete.
  }
}

export function listAgentCreationDrafts(userId?: string): AgentCreationDraftSummary[] {
  if (typeof window === "undefined") return [];

  const prefix = `${DRAFT_PREFIX}:v${DRAFT_VERSION}:`;
  const drafts: AgentCreationDraftSummary[] = [];
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;

      const parts = key.slice(prefix.length).split(":");
      const [owner, kind, audience, template] = parts;
      if (userId?.trim() && owner !== userId.trim()) continue;
      if ((kind !== "general" && kind !== "custom") || (audience !== "personal" && audience !== "customer_service")) continue;
      const draftKind = kind as AgentCreationDraftKind;
      const draftAudience = audience as AgentCreationDraftAudience;

      const value = readAgentCreationDraft<Record<string, unknown>>(key);
      if (!value) continue;
      const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";
      drafts.push({
        key,
        kind: draftKind,
        audience: draftAudience,
        templateKey: template && template !== "default" ? template : undefined,
        name: typeof value.name === "string" ? value.name : undefined,
        step: typeof value.step === "number" ? value.step : undefined,
        updatedAt,
      });
    }
  } catch {
    return [];
  }

  return drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
