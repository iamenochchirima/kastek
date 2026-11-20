import type { ContextGroup } from "./context";
import type { HarnessMessage } from "../business/model";

/** A tool result longer than this is shortened once the model has read it. */
export const READ_TOOL_RESULT_MAX_CHARS = 4_000;
/** The opening kept from a shortened tool result. */
export const READ_TOOL_RESULT_KEEP_CHARS = 2_000;

function shorten(message: HarnessMessage): HarnessMessage {
  if (message.role !== "tool" || typeof message.content !== "string" || message.content.length <= READ_TOOL_RESULT_MAX_CHARS) return message;
  const omitted = message.content.length - READ_TOOL_RESULT_KEEP_CHARS;
  return {
    ...message,
    content: `${message.content.slice(0, READ_TOOL_RESULT_KEEP_CHARS)}\n\n[Tool result shortened after it was read. ${omitted} characters omitted; the complete output remains in this task's execution trace.]`,
  };
}

/**
 * Shorten tool results the model has already read. The newest group is left
 * untouched because it has not been read yet. The stored groups are not mutated;
 * compaction and traces keep the complete output.
 */
export function trimReadToolResults(groups: ContextGroup[], options: { keepNewestGroup?: boolean } = {}): ContextGroup[] {
  const keepNewest = options.keepNewestGroup ?? true;
  return groups.map((group, index) => {
    if (keepNewest && index === groups.length - 1) return group;
    let changed = false;
    const messages = group.messages.map(message => {
      const next = shorten(message);
      if (next !== message) changed = true;
      return next;
    });
    return changed ? { ...group, messages } : group;
  });
}
