import type { ServerResponse } from "node:http";
import type { ModelProtocol } from "../src/contracts/model-providers";

export type PurposeAnswer = { text: string } | { name: string; args: Record<string, unknown> };
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
/** Native protocol fixtures only; no live model quality or credentials are represented. */
export function purposeResponse(response: ServerResponse, protocol: ModelProtocol, answer: PurposeAnswer): void {
  const tool = "name" in answer, id = tool && answer.name === "booking_availability" ? "availabc1" : tool && answer.name === "booking_reserve" ? "reservab1" : "callabc12", argumentsJson = tool ? JSON.stringify(answer.args) : undefined;
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (protocol === "openai_responses") {
    let stream = data({ type: "response.created", response: { id: "purpose-response" } });
    if (tool) stream += data({ type: "response.output_item.added", output_index: 0, item: { id: "function-1", type: "function_call", call_id: id, name: answer.name, arguments: "" } }) +
      data({ type: "response.function_call_arguments.delta", item_id: "function-1", output_index: 0, delta: argumentsJson }) +
      data({ type: "response.function_call_arguments.done", item_id: "function-1", output_index: 0, arguments: argumentsJson }) +
      data({ type: "response.output_item.done", output_index: 0, item: { id: "function-1", type: "function_call", call_id: id, name: answer.name, arguments: argumentsJson } });
    else stream += data({ type: "response.output_item.added", output_index: 0, item: { id: "message-1", type: "message", role: "assistant", content: [] } }) +
      data({ type: "response.content_part.added", item_id: "message-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
      data({ type: "response.output_text.delta", item_id: "message-1", output_index: 0, content_index: 0, delta: answer.text });
    response.end(stream + data({ type: "response.completed", response: { id: "purpose-response", status: "completed", output: [], usage: { input_tokens: 80, output_tokens: 8, total_tokens: 88 } } }));
  } else if (protocol === "anthropic_messages") {
    const event = (type: string, fields: object) => `event: ${type}\n${data({ type, ...fields })}`;
    response.end(event("message_start", { message: { id: "purpose-response", role: "assistant", content: [], usage: { input_tokens: 80, output_tokens: 0 } } }) +
      event("content_block_start", { index: 0, content_block: tool ? { type: "tool_use", id, name: answer.name, input: {} } : { type: "text", text: "" } }) +
      event("content_block_delta", { index: 0, delta: tool ? { type: "input_json_delta", partial_json: argumentsJson } : { type: "text_delta", text: answer.text } }) +
      event("content_block_stop", { index: 0 }) + event("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 8 } }) + event("message_stop", {}));
  } else if (protocol === "google_generate_content") {
    response.end(data({ candidates: [{ index: 0, content: { role: "model", parts: tool ? [{ functionCall: { id, name: answer.name, args: answer.args } }] : [{ text: answer.text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 8, totalTokenCount: 88 } }));
  } else {
    response.end(data({ id: "purpose-response", choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: answer.name, arguments: argumentsJson } }] }
      : { role: "assistant", content: answer.text }, finish_reason: tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 80, completion_tokens: 8, total_tokens: 88 } }) + "data: [DONE]\n\n");
  }
}
