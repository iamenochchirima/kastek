import type { ModelMessage } from "../model/types";
import { estimatePromptTokens } from "../model/credit-pricing";

const protectedTailMessages = 20;

export interface PreparedModelMessages {
  readonly messages: ModelMessage[];
  readonly compacted: boolean;
  readonly omittedMessageCount: number;
  readonly repairedPairCount: number;
}

/**
 * Hermes-style transcript safety at the model boundary. A model request never
 * receives an orphan tool result or an unanswered assistant tool call, and
 * compaction removes the middle of a conversation while protecting its latest
 * tool turns. Durable run steps remain the complete source of evidence.
 */
export function prepareModelMessages(input: {
  messages: readonly ModelMessage[];
  maxContextTokens: number;
  /** The provider-aware planner owns compaction when this is false. */
  compact?: boolean;
}): PreparedModelMessages {
  const repaired = repairToolPairs(input.messages);
  if (input.compact === false) return repaired;
  const budget = Math.max(256, Math.trunc(input.maxContextTokens));
  if (estimatePromptTokens({ messages: repaired.messages }) <= budget) {
    return { ...repaired, compacted: false };
  }

  const system = repaired.messages[0]?.role === "system" ? [repaired.messages[0]] : [];
  const body = repaired.messages.slice(system.length);
  let tailStart = Math.max(0, body.length - protectedTailMessages);
  tailStart = moveTailToPairBoundary(body, tailStart);
  let tail = body.slice(tailStart);
  const omitted = body.slice(0, tailStart);
  const summaryText = omitted.length
    ? `[Earlier conversation compacted by the runtime. ${omitted.length} messages remain durable in the execution record. Continue from the protected recent conversation below.]`
    : "[Conversation context was compacted by the runtime; continue from the protected recent conversation below.]";
  const summary: ModelMessage = { role: "system", content: summaryText };
  while (tail.length > 1 && estimatePromptTokens({ messages: [...system, summary, ...tail] }) > budget) {
    tail = tail.slice(1);
    tail = moveTailToPairBoundary(tail, 0) === 0 ? tail : tail.slice(moveTailToPairBoundary(tail, 0));
  }
  const messages = [...system, summary, ...tail];
  // A pathological single tool result must still be bounded before dispatch.
  if (estimatePromptTokens({ messages }) > budget) {
    const last = messages.at(-1);
    if (last && last.role !== "system") messages[messages.length - 1] = { ...last, content: last.content.slice(0, Math.max(32, budget * 4)) };
  }
  return {
    messages,
    compacted: true,
    omittedMessageCount: omitted.length,
    repairedPairCount: repaired.repairedPairCount,
  };
}

function repairToolPairs(messages: readonly ModelMessage[]): PreparedModelMessages {
  const output: ModelMessage[] = [];
  let repairedPairCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index]!;
    output.push(current);
    if (current.role !== "assistant" || !current.toolCalls?.length) continue;
    const following = new Set<string>();
    for (let cursor = index + 1; cursor < messages.length && messages[cursor]?.role === "tool"; cursor += 1) {
      if (messages[cursor]?.toolCallId) following.add(messages[cursor]!.toolCallId!);
    }
    for (const call of current.toolCalls) {
      if (following.has(call.id)) continue;
      output.push({ role: "tool", name: call.name, toolCallId: call.id, content: "Tool result unavailable because the prior execution was interrupted; do not claim success." });
      repairedPairCount += 1;
    }
  }
  return { messages: output, compacted: false, omittedMessageCount: 0, repairedPairCount };
}

function moveTailToPairBoundary(messages: readonly ModelMessage[], start: number): number {
  let cursor = Math.max(0, start);
  while (cursor > 0 && messages[cursor]?.role === "tool") cursor -= 1;
  return cursor;
}
