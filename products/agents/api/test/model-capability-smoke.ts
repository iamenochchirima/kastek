import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVED_MODEL_PROFILE, callModel, estimateRequestTokens, type ModelRequest, type ToolDefinition } from "../src/execution/business/model";

// Explicit opt-in only. This makes exactly two requests to the approved free model.
async function main(): Promise<void> {
  assert.equal(process.env.AGENTS_REAL_MODEL_PROBE, "1", "Set AGENTS_REAL_MODEL_PROBE=1 to authorize the free-model probe");
  const key = process.env.HARNESS_KEY_FILE ? readFileSync(process.env.HARNESS_KEY_FILE, "utf8").trim() : process.env.OPENROUTER_API_KEY;
  assert.ok(key, "Provide the approved key through a private file or process environment");
  const tool: ToolDefinition = { type: "function", function: { name: "memory_read", description: "Read the verified report-language preference",
    parameters: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"], additionalProperties: false } } };
  const request: ModelRequest = { model: `${APPROVED_MODEL_PROFILE.model}:free`, maxOutputTokens: 1024, maxDurationSeconds: 120,
    messages: [{ role: "system", content: "Use the provided tool exactly once to retrieve the preference. Do not guess. Input includes multilingual test data." },
      { role: "user", content: "What is my preferred report language? Test strings: 中文 日本語 isiZulu Shona français العربية 😀 🧪 \\n JSON {\"x\":\"é\"}." }],
    tools: [tool], toolChoice: { type: "function", function: { name: "memory_read" } } };
  const first = await callModel(request, { openRouterApiKey: key });
  assert.equal(first.finishReason, "tool_calls");
  assert.equal(first.message.tool_calls?.length, 1);
  const call = first.message.tool_calls![0]!;
  assert.equal(call.function.name, "memory_read");
  assert.equal(typeof JSON.parse(call.function.arguments).subject, "string");
  assert.ok(first.usage.inputTokens <= estimateRequestTokens(request) + APPROVED_MODEL_PROFILE.safetyTokens);
  const finalRequest: ModelRequest = { ...request, toolChoice: "none", messages: [
    { role: "system", content: "Answer from the returned verified preference. State the preferred language in one sentence." },
    ...request.messages.slice(1), first.message,
    { role: "tool", tool_call_id: call.id, content: JSON.stringify({ preferredLanguage: "Shona", source: "verified-test-preference" }) },
  ] };
  const final = await callModel(finalRequest, { openRouterApiKey: key });
  assert.equal(final.finishReason, "stop");
  assert.match(final.message.content!, /Shona/i);
  assert.ok(final.usage.inputTokens <= estimateRequestTokens(finalRequest) + APPROVED_MODEL_PROFILE.safetyTokens);
  console.log(JSON.stringify({ check: "real-free-model-harness-contract", model: request.model,
    profile: APPROVED_MODEL_PROFILE.id, tokenizerRevision: APPROVED_MODEL_PROFILE.tokenizerRevision,
    first: { finishReason: first.finishReason, estimatedInputUpperBound: estimateRequestTokens(request), usage: first.usage },
    final: { finishReason: final.finishReason, estimatedInputUpperBound: estimateRequestTokens(finalRequest), usage: final.usage },
    toolProtocol: true, unicodePayloadAccounting: true, paidFallback: false }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Model capability probe failed"); process.exitCode = 1; });
