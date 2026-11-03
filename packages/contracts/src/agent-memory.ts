export const MEMORY_ASSERTION_CONTEXTS = ["unspecified", "current", "hypothetical"] as const;
export const MEMORY_CONFLICT_STATES = ["not_assessed", "reported", "resolved"] as const;

/** Classification is a retained assertion, never independent verification or authority. */
export interface MemoryAssertion {
  context: typeof MEMORY_ASSERTION_CONTEXTS[number];
  conflict: typeof MEMORY_CONFLICT_STATES[number];
}

export function isMemoryAssertion(value: unknown): value is MemoryAssertion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 &&
    MEMORY_ASSERTION_CONTEXTS.includes(item.context as MemoryAssertion["context"]) &&
    MEMORY_CONFLICT_STATES.includes(item.conflict as MemoryAssertion["conflict"]);
}
