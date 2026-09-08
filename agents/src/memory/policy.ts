import type { MemoryNamespace, MemoryType } from "./legacy-contracts";

export type MemoryPolicyMode = "disabled" | "explicit" | "reviewed" | "automatic";

/**
 * An external projection is an opt-in policy decision, not a property of a
 * memory candidate.  Keeping the contract here means consolidation can only
 * request a provider projection after the agent policy has explicitly named
 * the provider and projection contract.
 */
export interface MemoryProviderProjectionPolicy {
  providerName: string;
  projectionVersion: string;
  payload: Record<string, unknown>;
}

export interface MemoryPolicy {
  mode: MemoryPolicyMode;
  readableNamespaces: MemoryNamespace[];
  writableNamespaces: MemoryNamespace[];
  writableTypes: MemoryType[];
  maxRetrieved: number;
  maxRetrievedTokens: number;
  maxWritesPerRun: number;
  retentionDays?: number;
  allowSensitive: boolean;
  providerProjection?: MemoryProviderProjectionPolicy;
}

const allNamespaces: MemoryNamespace[] = ["conversation", "user_private", "organization_shared", "agent_private"];
const allTypes: MemoryType[] = ["working", "semantic", "episodic", "procedural"];

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

function enumList<T extends string>(value: unknown, values: readonly T[], fallback: T[]): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set(values);
  const result = value.filter((item): item is T => typeof item === "string" && allowed.has(item as T));
  return result.length ? Array.from(new Set(result)) : [];
}

function providerProjection(value: unknown): MemoryProviderProjectionPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const providerName = typeof raw.providerName === "string" ? raw.providerName.trim() : "";
  if (!providerName || providerName.length > 160) return undefined;
  const projectionVersion = raw.projectionVersion === undefined
    ? "v1"
    : typeof raw.projectionVersion === "string" ? raw.projectionVersion.trim() : "";
  if (!projectionVersion || projectionVersion.length > 80) return undefined;
  const payload = raw.payload;
  if (payload !== undefined && (typeof payload !== "object" || payload === null || Array.isArray(payload))) return undefined;
  try {
    const normalizedPayload = payload === undefined ? {} : JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    if (JSON.stringify(normalizedPayload).length > 16_000) return undefined;
    return { providerName, projectionVersion, payload: normalizedPayload };
  } catch {
    return undefined;
  }
}

/**
 * Normalize user-editable policy data at the runtime boundary. Unknown fields
 * are ignored and limits are always bounded before they reach a repository or
 * a model context.
 */
export function normalizeMemoryPolicy(value: unknown): MemoryPolicy {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const mode: MemoryPolicyMode = raw.mode === "disabled" || raw.mode === "explicit" || raw.mode === "reviewed" || raw.mode === "automatic"
    ? raw.mode
    : "explicit";
  const retentionCandidate = raw.retentionDays;
  const retentionDays = retentionCandidate === undefined || retentionCandidate === null || retentionCandidate === ""
    ? undefined
    : boundedInteger(retentionCandidate, 365, 1, 3_650);
  const normalizedProviderProjection = providerProjection(raw.providerProjection);
  return {
    mode,
    readableNamespaces: enumList(raw.readableNamespaces, allNamespaces, allNamespaces),
    writableNamespaces: enumList(raw.writableNamespaces, allNamespaces, ["conversation", "user_private", "agent_private"]),
    writableTypes: enumList(raw.writableTypes, allTypes, ["working", "semantic", "episodic"]),
    maxRetrieved: boundedInteger(raw.maxRetrieved, 8, 0, 50),
    maxRetrievedTokens: boundedInteger(raw.maxRetrievedTokens, 1_600, 256, 8_000),
    maxWritesPerRun: boundedInteger(raw.maxWritesPerRun, 3, 0, 20),
    ...(retentionDays === undefined ? {} : { retentionDays }),
    allowSensitive: raw.allowSensitive === true,
    ...(normalizedProviderProjection ? { providerProjection: normalizedProviderProjection } : {}),
  };
}

export function memoryPolicyFromAgentPolicy(policy: unknown): MemoryPolicy {
  const raw = policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, unknown> : {};
  return normalizeMemoryPolicy("memory" in raw ? raw.memory : raw);
}
