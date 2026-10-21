import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { getProviderDefinition } from "../src/adapters/models/registry";
import type { ModelDescriptor } from "../src/contracts/model-providers";
import { probeProviderModel, type ModelProviderProbeRequest } from "../src/product/model-providers/probe";
import { defaultModelSetupPolicy } from "../src/product/model-providers/setup-policy";

const source = { kind: "operator" as const, reference: "fixture", observedAt: "2026-10-21T00:00:00.000Z" };
const model: ModelDescriptor = { id: "fixture-model", providerId: "openrouter", name: "Fixture", protocol: "openai_chat_completions",
  revision: "fixture", contextTokens: { value: 32000, source }, maxInputTokens: { value: 16000, source }, maxOutputTokens: { value: 1000, source },
  capabilities: { tools: { value: true, evidence: "declared", source }, reasoning: { value: null, evidence: "unknown", source: null },
    structuredOutput: { value: null, evidence: "unknown", source: null } }, inputModalities: ["text"], outputModalities: ["text"], pricing: null, lifecycle: "active" };
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
async function fixture(handler: (body: any, req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => { let body = ""; req.on("data", chunk => { body += chunk; }); req.on("end", () => handler(JSON.parse(body), req, res)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request: ModelProviderProbeRequest = { provider: { ...getProviderDefinition("openrouter")!, adapter: { ...getProviderDefinition("openrouter")!.adapter, readiness: "installed" } }, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    apiKey: "private-fixture-key", model, verifyTools: false, policy: { ...defaultModelSetupPolicy, probeDeadlineMs: 2000 }, reauthorize: () => {} };
  return request;
}
function chat(res: ServerResponse, delta: object = { content: "OK" }, reason = "stop", usage: object | null = { prompt_tokens: 9, completion_tokens: 2 }) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ id: "fixture-response", model: model.id, choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\ndata: [DONE]\n\n`);
}

describe("controlled billable provider setup probe", () => {
  it("makes one real capped request, reauthorizes at dispatch and returns only safe evidence", async () => {
    let calls = 0, authorized = 0;
    const input = await fixture((body, req, res) => {
      calls++; expect(authorized).toBe(1); expect(req.url).toBe("/v1/chat/completions");
      expect(req.headers.authorization).toBe("Bearer private-fixture-key"); expect(body.max_tokens).toBe(8);
      expect(body.provider).toEqual({ allow_fallbacks: false, require_parameters: true });
      expect(body.messages).toContainEqual({ role: "user", content: "Reply with only OK." }); chat(res);
    });
    const result = await probeProviderModel({ ...input, reauthorize: () => { authorized++; }, policy: { ...input.policy, probeMaxOutputTokens: 8 } }, { testLoopback: true });
    expect(calls).toBe(1); expect(result).toMatchObject({ modelId: model.id, httpStatus: 200, verification: "inference_verified", usage: { observed: true, inputTokens: 9, outputTokens: 2 } });
    expect(JSON.stringify(result)).not.toMatch(/private-fixture-key|nativeState|fixture-response|messages|assistant/);
  });

  it("proves the native tool round trip without external tool execution", async () => {
    let calls = 0, authorized = 0, nonce = "";
    const input = await fixture((body, _req, res) => {
      calls++; expect(authorized).toBe(calls);
      if (calls === 1) {
        nonce = body.tools[0].function.parameters.properties.token.const;
        expect(body.messages.at(-1).content).toContain(`Call setup_echo exactly once with token ${nonce}`);
        expect(body.tools).toHaveLength(1);
        chat(res, { tool_calls: [{ index: 0, id: "echo-1", type: "function", function: { name: "setup_echo", arguments: JSON.stringify({ token: nonce }) } }] }, "tool_calls");
      } else {
        expect(body.messages.at(-1)).toMatchObject({ role: "tool", content: nonce, tool_call_id: "echo-1" });
        expect(body.messages.at(-2).tool_calls[0].id).toBe("echo-1"); chat(res, { content: nonce });
      }
    });
    const result = await probeProviderModel({ ...input, verifyTools: true, reauthorize: () => { authorized++; } }, { testLoopback: true });
    expect(calls).toBe(2); expect(result).toMatchObject({ verification: "tools_verified", usage: { observed: true, inputTokens: 18, outputTokens: 4 } });
    expect(JSON.stringify(result)).not.toContain(nonce);
  });
  it("uses the native Anthropic messages path, fixed SDK beta query and header authentication", async () => {
    let calls = 0;
    const input = await fixture((body, req, res) => {
      calls++; expect(req.url).toBe("/v1/messages?beta=true"); expect(req.headers["x-api-key"]).toBe("private-fixture-key");
      expect(req.headers.authorization).toBeUndefined(); expect(body.max_tokens).toBe(256);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
      res.end(event("message_start", { message: { id: "probe", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }) +
        event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
        event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } }) +
        event("content_block_stop", { index: 0 }) + event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + event("message_stop", {}));
    });
    const provider = getProviderDefinition("anthropic")!;
    const result = await probeProviderModel({ ...input, provider, model: { ...model, providerId: provider.id, protocol: provider.protocol } }, { testLoopback: true });
    expect(calls).toBe(1); expect(result.verification).toBe("inference_verified"); expect(result.usage.observed).toBe(true);
  });
  it("tests Gemini through the protected REST path with header credentials", async () => {
    let calls = 0;
    const input = await fixture((body, req, res) => {
      calls++; expect(req.url).toBe("/v1/models/fixture-model:streamGenerateContent?alt=sse");
      expect(req.headers["x-goog-api-key"]).toBe("private-fixture-key"); expect(req.headers.authorization).toBeUndefined();
      expect(body.generationConfig.maxOutputTokens).toBe(256);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })}\n\n`);
    });
    const provider = { ...getProviderDefinition("google")!, adapter: { ...getProviderDefinition("google")!.adapter, readiness: "installed" as const } };
    const result = await probeProviderModel({ ...input, provider, model: { ...model, providerId: provider.id, protocol: provider.protocol } }, { testLoopback: true });
    expect(calls).toBe(1); expect(result.verification).toBe("inference_verified"); expect(result.usage.inputTokens).toBe(5);
  });

  it("allows genuinely missing usage without fabricated token counts", async () => {
    const input = await fixture((_body, _req, res) => chat(res, { content: "OK" }, "stop", null));
    expect((await probeProviderModel({ ...input, model: { ...model, maxInputTokens: { value: null, source: null } } }, { testLoopback: true })).usage).toEqual({ observed: false });
  });

  it.each([401, 402, 403, 429])("retains actual HTTP %s without a retry or secret-bearing provider error", async status => {
    let calls = 0;
    const input = await fixture((_body, _req, res) => { calls++; res.writeHead(status); res.end(JSON.stringify({ error: { message: "private-fixture-key refused" } })); });
    await expect(probeProviderModel(input, { testLoopback: true })).rejects.toMatchObject({ status, outcome: "rejected" });
    expect(calls).toBe(1);
  });

  it("does not dispatch after authority is revoked", async () => {
    let calls = 0;
    const input = await fixture((_body, _req, res) => { calls++; chat(res); });
    await expect(probeProviderModel({ ...input, reauthorize: () => { throw new Error("revoked private-fixture-key"); } }, { testLoopback: true }))
      .rejects.toMatchObject({ code: "MODEL_NETWORK_AUTHORIZATION_DENIED", outcome: "rejected" });
    expect(calls).toBe(0);
  });

  it("checks authority again before the tool continuation", async () => {
    let calls = 0, checks = 0;
    const input = await fixture((body, _req, res) => { calls++; chat(res, { tool_calls: [{ index: 0, id: "echo-1", type: "function", function: {
      name: "setup_echo", arguments: JSON.stringify({ token: body.tools[0].function.parameters.properties.token.const }) } }] }, "tool_calls"); });
    await expect(probeProviderModel({ ...input, verifyTools: true, reauthorize: () => { if (++checks === 2) throw new Error("revoked"); } }, { testLoopback: true }))
      .rejects.toMatchObject({ code: "MODEL_NETWORK_AUTHORIZATION_DENIED", outcome: "rejected" });
    expect(calls).toBe(1); expect(checks).toBe(2);
  });

  it.each(["text", "wrong-tool", "wrong-token", "extra-property"])("rejects %s as proof of tool support", async kind => {
    let calls = 0;
    const input = await fixture((body, _req, res) => {
      calls++;
      if (kind === "text") { chat(res); return; }
      const token = body.tools[0].function.parameters.properties.token.const;
      chat(res, { tool_calls: [{ index: 0, id: "echo-1", type: "function", function: { name: kind === "wrong-tool" ? "external_delete" : "setup_echo",
        arguments: JSON.stringify({ token: kind === "wrong-token" ? "bad" : token, ...(kind === "extra-property" ? { extra: true } : {}) }) } }] }, "tool_calls");
    });
    await expect(probeProviderModel({ ...input, verifyTools: true }, { testLoopback: true })).rejects.toMatchObject({ code: "MODEL_PROBE_TOOL_CALL_INVALID" });
    expect(calls).toBe(1);
  });

  it("rejects an incorrect tool continuation even after a valid native call", async () => {
    let calls = 0;
    const input = await fixture((body, _req, res) => {
      calls++;
      if (calls === 1) chat(res, { tool_calls: [{ index: 0, id: "echo-1", type: "function", function: {
        name: "setup_echo", arguments: JSON.stringify({ token: body.tools[0].function.parameters.properties.token.const }) } }] }, "tool_calls");
      else chat(res, { content: "I did something else" });
    });
    await expect(probeProviderModel({ ...input, verifyTools: true }, { testLoopback: true }))
      .rejects.toMatchObject({ code: "MODEL_PROBE_TOOL_ROUND_TRIP_INVALID" });
    expect(calls).toBe(2);
  });

  it("rejects missing metadata, missing key and unapproved private destinations before dispatch", async () => {
    let calls = 0;
    const input = await fixture((_body, _req, res) => { calls++; chat(res); });
    await expect(probeProviderModel({ ...input, model: { ...model, contextTokens: { value: null, source: null } } }, { testLoopback: true })).rejects.toMatchObject({ code: "MODEL_PROBE_CAPACITY_UNKNOWN" });
    await expect(probeProviderModel({ ...input, apiKey: "" }, { testLoopback: true })).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_INVALID" });
    await expect(probeProviderModel(input)).rejects.toMatchObject({ code: "MODEL_ENDPOINT_INVALID" });
    expect(calls).toBe(0);
  });

  it("enforces byte and shared deadline protections", async () => {
    let calls = 0;
    const input = await fixture((_body, _req, res) => { calls++; res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": heartbeat\n\n"); });
    await expect(probeProviderModel({ ...input, policy: { ...input.policy, probeMaxRequestBytes: 1 } }, { testLoopback: true })).rejects.toMatchObject({ outcome: "rejected" });
    expect(calls).toBe(0);
    await expect(probeProviderModel({ ...input, policy: { ...input.policy, probeDeadlineMs: 30 } }, { testLoopback: true })).rejects.toMatchObject({ outcome: "uncertain" });
    expect(calls).toBe(1);
  });
});
