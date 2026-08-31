import type { MemoryNamespace, MemoryType } from "../db/repositories/memory-repository";

export type MemoryPolicyMode = "disabled" | "explicit" | "reviewed" | "automatic";

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
  };
}

export function memoryPolicyFromAgentPolicy(policy: unknown): MemoryPolicy {
  const raw = policy && typeof policy === "object" && !Array.isArray(policy) ? policy as Record<string, unknown> : {};
  return normalizeMemoryPolicy("memory" in raw ? raw.memory : raw);
}
