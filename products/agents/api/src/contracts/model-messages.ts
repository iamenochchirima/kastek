export interface HarnessToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface HarnessMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: HarnessToolCall[];
  tool_call_id?: string;
}
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown>; strict?: boolean };
}
