import type { ModelMessage } from "../model/types";
import { validateModelTranscript } from "./transcript";

export class TranscriptProjectionError extends Error {
  public readonly code = "TRANSCRIPT_PROJECTION_INVALID" as const;

  public constructor(public readonly issues: ReturnType<typeof validateModelTranscript>) {
    super("The model transcript contains an incomplete or out-of-order tool round");
    this.name = "TranscriptProjectionError";
  }
}

export interface PreparedModelMessages {
  readonly messages: ModelMessage[];
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
  const issues = validateModelTranscript(input.messages);
  if (issues.length > 0) throw new TranscriptProjectionError(issues);
  return { messages: input.messages.map((message) => ({ ...message, ...(message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call, arguments: { ...call.arguments } })) } : {}) })) };
}
