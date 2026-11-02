import type { ContextGroup, ContextSource } from "./context";

export interface CompactionProgress {
  groupIds: string[];
  remainingBytes: number;
}

export function measureCompactionProgress(groups: ContextGroup[], summary?: ContextSource): CompactionProgress {
  return { groupIds: groups.map(group => group.id),
    remainingBytes: Buffer.byteLength(JSON.stringify(groups.map(group => group.messages))) + Buffer.byteLength(summary?.content ?? "") };
}

/** Prefix packing can grow while the full remaining context shrinks. New input starts a fresh comparison. */
export function compactionDidNotProgress(previous: CompactionProgress | undefined, current: CompactionProgress): boolean {
  return previous !== undefined && current.groupIds.every(id => previous.groupIds.includes(id)) &&
    current.remainingBytes >= previous.remainingBytes;
}
