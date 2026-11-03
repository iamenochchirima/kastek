import type { ContextGroup, ContextSource } from "./context";

export interface CompactionProgress {
  groupIds: string[];
  remainingBytes: number;
}

/** Observed growth advances the model's configured trigger; it never enlarges its window. */
export function compactionForecast(policy:{maxInputTokens:number;compactAtTokens:number;safetyTokens:number},current:number,previous?:number,mandatory=0){
  const growthTokens=previous===undefined?0:Math.max(0,current-previous);
  const reserveTokens=policy.safetyTokens+growthTokens;
  const base=Math.min(current,Math.max(0,mandatory));
  const relativeTrigger=base+Math.floor((policy.maxInputTokens-base)*policy.compactAtTokens/policy.maxInputTokens);
  const triggerTokens=Math.max(base+1,Math.min(relativeTrigger,Math.max(1,policy.maxInputTokens-reserveTokens)));
  return {growthTokens,reserveTokens,mandatoryTokens:base,triggerTokens,requested:current>=triggerTokens};
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
