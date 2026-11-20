import type { ContextGroup } from "./context";

export interface PruneResult {
  omitted: string[];
  working: ContextGroup[];
  pruned: string[];
}

/**
 * Drop the oldest compacted groups without a summary when summarization fails.
 *
 * This is the bounded fallback for automatic contexts: the stored turns and their
 * evidence remain intact for history search/read, but they stop consuming the
 * request. It is idempotent because already-omitted groups are not pruned again.
 */
export function pruneCompactedGroups(omitted: readonly string[], working: readonly ContextGroup[], compactedGroupIds: readonly string[]): PruneResult {
  const pruned = compactedGroupIds.filter(id => !omitted.includes(id));
  if (!pruned.length) return { omitted: [...omitted], working: [...working], pruned: [] };
  return {
    omitted: [...omitted, ...pruned],
    working: working.filter(group => !pruned.includes(group.id)),
    pruned,
  };
}
