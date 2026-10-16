import type { ModelProvider } from "./types";

export type OpenCodeModelProtocol =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content";

/**
 * OpenCode's catalogs return model IDs, while its published endpoint table
 * assigns protocols by model family. Keep model discovery and execution on
 * the same route decision; unrecognized models stay out of the picker until
 * their protocol is known.
 */
export function openCodeModelProtocol(provider: ModelProvider, model: string): OpenCodeModelProtocol | undefined {
  if (provider !== "opencode_go" && provider !== "opencode_zen") return undefined;

  if (/^jev-/i.test(model)) return undefined; // System One returns typed judgements, not chat messages.
  if (/^(?:gpt-|grok-|muse-spark-)/i.test(model)) return "openai-responses";
  if (/^(?:claude-|qwen\d)/i.test(model) || (provider === "opencode_go" && /^minimax-/i.test(model))) return "anthropic-messages";
  if (provider === "opencode_zen" && /^gemini-/i.test(model)) return "gemini-generate-content";

  const chatCompletionsModel = provider === "opencode_go"
    ? /^(?:deepseek-|glm-|kimi-|hy[34](?:-|$)|mimo-|longcat-)/i
    : /^(?:deepseek-|glm-|kimi-|minimax-|big-pickle$|space-bunny-|longcat-|fledge-|mimo-|ling-|nemotron-)/i;
  return chatCompletionsModel.test(model) ? "openai-chat-completions" : undefined;
}
