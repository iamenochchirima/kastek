import type { ModelMessage } from "../model/types";

export interface PreparedModelMessages {
  readonly messages: ModelMessage[];
  readonly repairedPairCount: number;
}

/**
 * Structural transcript safety at the model boundary. A model request never
 * receives an orphan tool result or an unanswered assistant tool call. The
 * provider-aware context planner owns all pruning and compaction decisions;
 * this helper must not make an independent token decision.
 */
export function prepareModelMessages(input: {
  messages: readonly ModelMessage[];
}): PreparedModelMessages {
  return repairToolPairs(input.messages);
}

function repairToolPairs(messages: readonly ModelMessage[]): PreparedModelMessages {
  const output: ModelMessage[] = [];
  const knownCalls = new Map<string, { name: string }>();
  const resolvedCalls = new Set<string>();
  let repairedPairCount = 0;

  // Establish which results belong to an assistant call before emitting any
  // placeholders. This keeps a valid later result from being duplicated by a
  // recovery marker, while still rejecting results that have no preceding
  // assistant call.
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index]!;
    if (current.role === "assistant" && current.toolCalls?.length) {
      for (const call of current.toolCalls) knownCalls.set(call.id, { name: call.name });
      continue;
    }
    if (current.role === "tool" && current.toolCallId && knownCalls.has(current.toolCallId) && !resolvedCalls.has(current.toolCallId)) {
      resolvedCalls.add(current.toolCallId);
    }
  }

  for (const current of messages) {
    if (current.role === "assistant" && current.toolCalls?.length) {
      output.push(current);
      for (const call of current.toolCalls) {
        if (resolvedCalls.has(call.id)) continue;
        output.push({ role: "tool", name: call.name, toolCallId: call.id, content: "Tool result unavailable because the prior execution was interrupted; do not claim success." });
        repairedPairCount += 1;
      }
      continue;
    }
    if (current.role === "tool") {
      if (!current.toolCallId || !resolvedCalls.has(current.toolCallId)) {
        repairedPairCount += 1;
        continue;
      }
      output.push(current);
      resolvedCalls.delete(current.toolCallId);
      continue;
    }
    output.push(current);
  }
  return { messages: output, repairedPairCount };
}
