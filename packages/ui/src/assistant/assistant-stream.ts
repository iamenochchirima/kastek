import type { AssistantStreamEvent, AssistantStreamState } from "./assistant-types.js";

export function applyAssistantStreamEvent(current: AssistantStreamState, event: AssistantStreamEvent): AssistantStreamState {
  switch (event.type) {
    case "accepted":
      return { ...current, state: "accepted", taskId: event.messageId };
    case "delta":
      return { ...current, state: "streaming" };
    case "status":
      return { ...current, state: "streaming", label: event.state };
    case "sources":
      return { ...current, sources: event.sources };
    case "completed":
      return { ...current, state: "completed", message: event.message, sources: event.message.sources ?? current.sources, error: undefined };
    case "failed":
      return { ...current, state: "failed", error: event.message };
    case "uncertain":
      return { ...current, state: "uncertain", error: event.message };
  }
}

export function isAssistantStreamTerminal(state: AssistantStreamState["state"] | undefined) {
  return state === "completed" || state === "failed" || state === "uncertain";
}
