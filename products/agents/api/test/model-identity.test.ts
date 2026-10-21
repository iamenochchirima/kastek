import { describe, expect, it } from "vitest";
import { callProviderModel } from "../src/adapters/models/pi-transport";
import { modelIdentitySchema, type ProviderTransportRequest } from "../src/contracts/model-transport";

const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const request: ProviderTransportRequest = { provider: "fixture", protocol: "openai_chat_completions", model: "fixture-model",
  baseUrl: "https://fixture.invalid/v1", credentialRevision: "fixture-1", contextWindowTokens: 32000, maxOutputTokens: 32,
  messages: [{ role: "user", content: "Hello" }] };
function events(protocol: ProviderTransportRequest["protocol"], identities: unknown[]): string {
  const field = (value: unknown, key: string) => value === undefined ? {} : { [key]: value };
  if (protocol === "openai_chat_completions") return identities.map((id, index) => sse({ id: "response-1", ...field(id, "model"),
    choices: [{ index: 0, delta: { content: index === 0 ? "OK" : "" }, finish_reason: index === identities.length - 1 ? "stop" : null }] })).join("") + "data: [DONE]\n\n";
  if (protocol === "google_generate_content") return identities.map((id, index) => sse({ ...field(id, "modelVersion"),
    candidates: [{ index: 0, content: { role: "model", parts: [{ text: index === 0 ? "OK" : "" }] },
      ...(index === identities.length - 1 ? { finishReason: "STOP" } : {}) }] })).join("");
  if (protocol === "anthropic_messages") {
    const event = (type: string, data: object) => `event: ${type}\n${sse({ type, ...data })}`;
    return identities.map(id => event("message_start", { message: { id: "message-1", role: "assistant", ...field(id, "model"), content: [], usage: { input_tokens: 1, output_tokens: 0 } } })).join("") +
      event("content_block_start", { index: 0, content_block: { type: "text", text: "OK" } }) + event("content_block_stop", { index: 0 }) +
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + event("message_stop", {});
  }
  return identities.map(id => sse({ type: "response.created", response: { id: "response-1", ...field(id, "model") } })).join("") +
    sse({ type: "response.output_item.added", output_index: 0, item: { id: "message-1", type: "message", role: "assistant", content: [] } }) +
    sse({ type: "response.content_part.added", item_id: "message-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
    sse({ type: "response.output_text.delta", item_id: "message-1", output_index: 0, content_index: 0, delta: "OK" }) +
    sse({ type: "response.completed", response: { id: "response-1", status: "completed", output: [] } });
}
for (const protocol of ["openai_chat_completions", "openai_responses", "anthropic_messages", "google_generate_content"] as const) {
  describe(`${protocol} returned identity receipt`, () => {
    const call = (identities: unknown[]) => callProviderModel({ ...request, protocol }, { apiKey: "private-key", fetch: (async () => new Response(events(protocol, identities), { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
    it.each([["fixture-model", "same"], ["fixture-model-2026-10", "different"], [undefined, "unreported"]] as const)("records %s without changing the requested route", async (returnedModelId, relation) => {
      const result = await call([returnedModelId]);
      expect(result.modelIdentity).toEqual({ requestedModelId: "fixture-model", returnedModelId: returnedModelId ?? null, relation });
      expect(result.nativeState.model).toBe("fixture-model");
      expect(JSON.stringify(result.modelIdentity)).not.toContain("private-key");
    });
    it.each([null, 7, "", " ", " alias ", "invalid\nmodel", "x".repeat(513)])("rejects malformed reported identity %j as an uncertain physical outcome", async invalid => {
      await expect(call([invalid])).rejects.toMatchObject({ code: "MODEL_RESPONSE_IDENTITY_INVALID", outcome: "uncertain" });
    });
    it("rejects conflicting identities rather than claiming an approved alias", async () => {
      await expect(call(["fixture-model-version-a", "fixture-model-version-b"])).rejects.toMatchObject({ code: "MODEL_RESPONSE_IDENTITY_CONFLICT", outcome: "uncertain" });
    });
    it("allows repeated stable identity reports", async () => {
      expect((await call(["fixture-model-version-a", "fixture-model-version-a"])).modelIdentity?.returnedModelId).toBe("fixture-model-version-a");
    });
  });
}
it("captures returned identity from the native Mistral chunk callback", async () => {
  const result = await callProviderModel({ ...request, provider: "mistral", model: "mistral-small-latest", baseUrl: "https://api.mistral.ai/v1" },
    { apiKey: "private-key", fetch: (async () => new Response(events("openai_chat_completions", ["mistral-small-2026"]), { headers: { "content-type": "text/event-stream" } })) as typeof fetch });
  expect(result.modelIdentity).toEqual({ requestedModelId: "mistral-small-latest", returnedModelId: "mistral-small-2026", relation: "different" });
  expect(result.nativeState.model).toBe("mistral-small-latest");
});
it("rejects a receipt that falsely claims model equivalence or contains extra private fields", () => {
  expect(modelIdentitySchema.safeParse({ requestedModelId: "alias", returnedModelId: "actual", relation: "same" }).success).toBe(false);
  expect(modelIdentitySchema.safeParse({ requestedModelId: "alias", returnedModelId: null, relation: "unreported", privateThinking: "secret" }).success).toBe(false);
});
