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
  let repairedPairCount = 0;

  // Validate only the contiguous tool-result group that follows the current
  // assistant call. A global call index would incorrectly accept a result that
  // appears before its assistant call, which is not a valid provider transcript.
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index]!;
    if (current.role === "assistant" && current.toolCalls?.length) {
      output.push(current);

      const calls = new Map(current.toolCalls.map((call) => [call.id, call]));
      const results = new Map<string, ModelMessage>();
      let cursor = index + 1;
      while (cursor < messages.length && messages[cursor]?.role === "tool") {
        const result = messages[cursor]!;
        if (!result.toolCallId || !calls.has(result.toolCallId) || results.has(result.toolCallId)) {
          repairedPairCount += 1;
        } else {
          results.set(result.toolCallId, result);
        }
        cursor += 1;
      }

      for (const call of current.toolCalls) {
        const result = results.get(call.id);
        if (result) {
          output.push(result);
        } else {
          output.push({ role: "tool", name: call.name, toolCallId: call.id, content: "Tool result unavailable because the prior execution was interrupted; do not claim success." });
          repairedPairCount += 1;
        }
      }
      index = cursor - 1;
      continue;
    }
    if (current.role === "tool") {
      repairedPairCount += 1;
      continue;
    }
    output.push(current);
  }
  return { messages: output, repairedPairCount };
}
