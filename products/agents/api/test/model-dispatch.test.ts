import { modelControlsRevision } from "../src/adapters/models/model-controls";
import { prepareInputCount } from "../src/adapters/models/input-count";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlatformError, requestDigest } from "../src/contracts/contracts";
import type { ModelProtocol } from "../src/contracts/model-providers";
import { createModelFetch, type ModelFetch, type ModelNetworkPolicy } from "../src/infrastructure/model-network";
import { dispatchBoundModel, type AcceptedModelDispatch, type BoundModelDispatchInput } from "../src/execution/models/dispatch";

const source = { kind: "operator" as const, reference: "controlled-dispatch-fixture", observedAt: "2026-10-21T00:00:00.000Z" };
function accepted(protocol: ModelProtocol = "openai_chat_completions"): AcceptedModelDispatch {
  const definition = { id: "fixture", name: "Fixture", protocol, baseUrl: "https://fixture.invalid/v1",
    auth: protocol === "anthropic_messages" ? { kind: "header" as const, headerName: "x-api-key" } : { kind: "bearer" as const },
    discovery: { kind: "curated" as const }, officialDocsUrl: "https://fixture.invalid/docs",
    adapter: { id: "fixture-adapter", revision: "1", readiness: "installed" as const } };
  const policy = { revision: "fixture-1", digest: "b".repeat(64), contextTokens: 32000, maxInputTokens: 16000, maxOutputTokens: 32,
    safetyTokens: 1000, compactAtTokens: 12000, maxModelCalls: 10, maxToolCalls: 10, maxCallDurationMs: 2000, maxDurationMs: 2000,
    maxInputBytes: 100, maxRequestBytes: 2097152, maxMessages: 256, maxTools: 64, maxResponseBytes: 100000, maxRootTokens: 32000, maxCostMicros: null };
  return { definition, policy, consumer: { kind: "agent", agentId: randomUUID() },
    model: { id: "fixture-model", providerId: "fixture", name: "Fixture model", protocol, revision: "fixture-1",
      contextTokens: { value: 32000, source }, maxInputTokens: { value: 16000, source }, maxOutputTokens: { value: 32, source },
      capabilities: { tools: { value: true, evidence: "verified", source }, reasoning: { value: null, evidence: "unknown", source: null },
        structuredOutput: { value: null, evidence: "unknown", source: null } }, inputModalities: ["text"], outputModalities: ["text"], pricing: null, lifecycle: "active" },
    binding: { organizationId: randomUUID(), connectionId: randomUUID(), connectionRevision: 1, credentialRevision: 1,
      useGrantId: randomUUID(), useGrantRevision: 1, providerId: "fixture", providerDefinitionDigest: requestDigest(definition),
      endpoint: definition.baseUrl, protocol, modelId: "fixture-model", modelRevision: "fixture-1", adapterId: definition.adapter.id,
      adapterRevision: "1", role: "primary", policyDigest: policy.digest } };
}
function input(route = accepted()) {
  let activeConnections = 0;
  const pool = { connect: async () => {
    activeConnections++;
    return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), release: () => { activeConnections--; } };
  } } as unknown as Pool;
  const resolveCredential = vi.fn(async () => "private-fixture-key");
  const request: BoundModelDispatchInput = { pool, providerStore: { resolveCredential }, accepted: route,
    messages: [{ role: "user", content: "Hello" }], maxRequestBytes: 100000 };
  return { request, resolveCredential, activeConnections: () => activeConnections };
}
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function response(protocol: ModelProtocol) {
  if (protocol === "anthropic_messages") {
    const event = (type: string, value: object) => `event: ${type}\n${sse({ type, ...value })}`;
    return event("message_start", { message: { id: "fixture-message", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 3, output_tokens: 0 } } }) +
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }) + event("content_block_stop", { index: 0 }) +
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }) + event("message_stop", {});
  }
  if (protocol === "openai_responses") return sse({ type: "response.created", response: { id: "fixture-message", model: "fixture-model" } }) +
    sse({ type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } }) +
    sse({ type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
    sse({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "Hello" }) +
    sse({ type: "response.completed", response: { id: "fixture-message", status: "completed", usage: { input_tokens: 3, output_tokens: 1 }, output: [] } });
  return sse({ id: "fixture-message", model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 } }) + "data: [DONE]\n\n";
}
async function fixture(protocol: ModelProtocol = "openai_chat_completions", onRequest?: () => void, status = 200, counter?: { status: number; body: unknown }, origin = "https://fixture.invalid", streamBody?: string) {
  const calls: Array<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = createServer((request, reply) => {
    onRequest?.(); let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      calls.push({ path: request.url!, headers: request.headers, body: JSON.parse(body) });
      if (request.url?.endsWith("/input_tokens")) { reply.writeHead(counter?.status ?? 200, { "content-type": "application/json" }); reply.end(JSON.stringify(counter?.body ?? {input_tokens:3})); return; }
      reply.writeHead(status, { "Content-Type": status === 200 ? "text/event-stream" : "application/json" });
      reply.end(status === 200 ? streamBody ?? response(protocol) : JSON.stringify({ error: { message: "private-fixture-key denied" } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closes.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const loopback = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let networkPolicy: ModelNetworkPolicy | undefined;
  // Keep every network control. Only replace the fixture origin after checking the production authority predicate.
  const factory = (policy: ModelNetworkPolicy): ModelFetch => {
    networkPolicy = policy;
    const controlled = createModelFetch({ ...policy, testLoopback: true,
      authorizeUrl: url => url.origin === loopback && policy.authorizeUrl(new URL(url.pathname + url.search, origin)) });
    const wrapped = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(policy.authorizeUrl(target)).toBe(true);
      return controlled(new URL(target.pathname + target.search, loopback), init);
    }) as ModelFetch;
    wrapped.markProgress = controlled.markProgress;
    return wrapped;
  };
  return { calls, factory, policy: () => networkPolicy! };
}

describe("authorized bound model dispatch", () => {
  it("withholds a reflected credential across streamed chunks", async () => {
    const state = input(), visible: string[] = [];
    const stream = sse({ id: "fixture-message", model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "private-fixture-" }, finish_reason: null }] }) +
      sse({ id: "fixture-message", model: "fixture-model", choices: [{ index: 0, delta: { content: "key" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } }) + "data: [DONE]\n\n";
    const server = await fixture("openai_chat_completions", undefined, 200, undefined, undefined, stream);
    await expect(dispatchBoundModel({ ...state.request, onText: text => visible.push(text) }, server.factory))
      .rejects.toMatchObject({ code: "MODEL_CREDENTIAL_REFLECTION", outcome: "uncertain" });
    expect(visible).toEqual([]);
    expect(server.calls).toHaveLength(1);
  });
  it("does not transmit its credential in model context", async () => {
    const state = input(), server = await fixture();
    await expect(dispatchBoundModel({ ...state.request, messages: [{ role: "user", content: "private-fixture-key" }] }, server.factory))
      .rejects.toMatchObject({ code: "MODEL_CREDENTIAL_IN_CONTEXT", outcome: "rejected" });
    expect(server.calls).toHaveLength(0);
  });
  it("keeps the completed response when a progress observer fails", async () => {
    const state = input(), server = await fixture();
    const result = await dispatchBoundModel({ ...state.request, onText: () => { throw new Error("observer unavailable"); } }, server.factory);
    expect(result.message.content).toBe("Hello");
    expect(server.calls).toHaveLength(1);
  });
  it.each(["openai_chat_completions", "openai_responses", "anthropic_messages"] as const)("streams %s through a protected exact HTTP route", async protocol => {
    const state = input(accepted(protocol)), deltas: string[] = [];
    const server = await fixture(protocol, () => { expect(state.activeConnections()).toBe(0); });
    const beforeDispatch = vi.fn(() => { expect(state.activeConnections()).toBe(0); });
    const result = await dispatchBoundModel({ ...state.request, onText: value => deltas.push(value), beforeDispatch }, server.factory);
    expect(result.message.content).toBe("Hello"); expect(deltas.join("")).toBe("Hello");
    expect(result.usage).toMatchObject({ observed: true, inputTokens: 3, outputTokens: 1 });
    expect(server.calls).toHaveLength(1); expect(state.resolveCredential).toHaveBeenCalledTimes(2); expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(state.resolveCredential.mock.calls[0]![1]).toEqual(state.request.accepted.binding);
    expect(state.resolveCredential.mock.calls[0]![2]).toEqual(state.request.accepted.consumer);
    expect(new URL(server.calls[0]!.path, "https://fixture.invalid").pathname).toBe(protocol === "anthropic_messages" ? "/v1/messages" : protocol === "openai_responses" ? "/v1/responses" : "/v1/chat/completions");
    expect(server.calls[0]!.headers[protocol === "anthropic_messages" ? "x-api-key" : "authorization"]).toBe(protocol === "anthropic_messages" ? "private-fixture-key" : "Bearer private-fixture-key");
    expect(server.calls[0]!.body[protocol === "openai_responses" ? "max_output_tokens" : "max_tokens"]).toBe(32);
    expect(JSON.stringify(result)).not.toContain("private-fixture-key");
    expect(server.policy().authorizeUrl(new URL("https://foreign.invalid/v1/chat/completions"))).toBe(false);
    expect(server.policy().authorizeUrl(new URL("https://fixture.invalid/v1/models"))).toBe(false);
    expect(server.policy().authorizeUrl(new URL(`https://fixture.invalid${new URL(server.calls[0]!.path, "https://fixture.invalid").pathname}?key=ambient`))).toBe(false);
    expect(server.policy().maxRequestBytes).toBe(100000); expect(server.policy().maxResponseBytes).toBe(100000);
  });
  it("denies rotated keys and revoked grants immediately before physical dispatch", async () => {
    for (const revoked of [false, true]) {
      const state = input(), server = await fixture();
      await expect(dispatchBoundModel({ ...state.request, beforeDispatch: async () => {
        if (revoked) state.resolveCredential.mockRejectedValueOnce(new PlatformError("MODEL_USE_DENIED", 403, "private-fixture-key"));
        else state.resolveCredential.mockResolvedValueOnce("rotated-private-key");
      } }, server.factory)).rejects.toMatchObject({ code: "MODEL_NETWORK_AUTHORIZATION_DENIED", outcome: "rejected" });
      expect(server.calls).toHaveLength(0); expect(state.resolveCredential).toHaveBeenCalledTimes(2); expect(state.activeConnections()).toBe(0);
    }
  });
  it("checks accepted snapshots before secret access", async () => {
    for (const mutate of [
      (route: AcceptedModelDispatch) => { route.binding.policyDigest = "c".repeat(64); },
      (route: AcceptedModelDispatch) => { route.model.revision = "changed"; },
      (route: AcceptedModelDispatch) => { route.definition.auth = { kind: "header", headerName: "x-unsafe" }; },
      (route: AcceptedModelDispatch) => { route.binding.protocol = "openai_responses"; },
      (route: AcceptedModelDispatch) => { route.policy.maxOutputTokens = 33; },
    ]) {
      const state = input(); mutate(state.request.accepted);
      await expect(dispatchBoundModel(state.request)).rejects.toMatchObject({ code: "MODEL_ACCEPTED_BINDING_MISMATCH", outcome: "rejected" });
      expect(state.resolveCredential).not.toHaveBeenCalled();
    }
  });
  it("rejects uninstalled adapters before secret access", async () => {
    const route = accepted(); route.definition.adapter.readiness = "planned";
    route.binding.providerDefinitionDigest = requestDigest(route.definition);
    const state = input(route);
    await expect(dispatchBoundModel(state.request)).rejects.toMatchObject({ code: "MODEL_ADAPTER_NOT_INSTALLED", status: 501 });
    expect(state.resolveCredential).not.toHaveBeenCalled();
  });
  it("preserves the enclosing deadline and rejects pre-cancelled or expired calls", async () => {
    const state = input(), server = await fixture(), deadlineAt = Date.now() + 1000;
    await dispatchBoundModel({ ...state.request, deadlineAt }, server.factory);
    expect(server.policy().deadlineAt).toBe(deadlineAt);
    const cancelled = input();
    await expect(dispatchBoundModel({ ...cancelled.request, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "MODEL_CANCELLED_BEFORE_DISPATCH", outcome: "rejected" });
    await expect(dispatchBoundModel({ ...cancelled.request, deadlineAt: Date.now() - 1 })).rejects.toMatchObject({ code: "MODEL_NETWORK_DEADLINE", outcome: "rejected" });
    expect(cancelled.resolveCredential).not.toHaveBeenCalled();
  });
  it("enforces serialized request limits before dispatch and never retries provider rejections", async () => {
    const state = input(), server = await fixture();
    await expect(dispatchBoundModel({ ...state.request, maxRequestBytes: 5 }, server.factory)).rejects.toMatchObject({ outcome: "rejected" });
    expect(server.calls).toHaveLength(0);
    const rejected = await fixture("openai_chat_completions", undefined, 401);
    await expect(dispatchBoundModel(state.request, rejected.factory)).rejects.toMatchObject({ code: "MODEL_AUTHENTICATION_FAILED", outcome: "rejected",diagnostics:{httpStatus:401,stage:"provider_stream",dispatched:true} });
    expect(rejected.calls).toHaveLength(1);
    const unavailable = await fixture("openai_chat_completions", undefined, 503);
    await expect(dispatchBoundModel(state.request, unavailable.factory)).rejects.toMatchObject({ code: "MODEL_PROVIDER_UNAVAILABLE", status: 503, outcome: "rejected",
      diagnostics: { httpStatus: 503, stage: "provider_stream", dispatched: true } });
    expect(unavailable.calls).toHaveLength(1);
  });
  it("copies accepted authority before asynchronous work and keeps native continuation route-bound", async () => {
    const state = input(), server = await fixture();
    state.resolveCredential.mockImplementationOnce(async () => {
      state.request.accepted.binding.endpoint = "https://foreign.invalid/v1";
      state.request.accepted.model.id = "unapproved-model";
      return "private-fixture-key";
    });
    const first = await dispatchBoundModel(state.request, server.factory);
    expect(server.calls).toHaveLength(1);
    expect(first.nativeState.baseUrl).toBe("https://fixture.invalid/v1");
    expect(first.nativeState.model).toBe("fixture-model");
    const next = input();
    await expect(dispatchBoundModel({ ...next.request,
      messages: [...next.request.messages, first.message, { role: "user", content: "Continue" }],
      nativeHistory: { 1: { ...first.nativeState, credentialRevision: "stale" } },
    }, server.factory)).rejects.toMatchObject({ code: "MODEL_NATIVE_STATE_MISMATCH", outcome: "rejected" });
    expect(server.calls).toHaveLength(1);
  });
  it("retains production private-address protections without an injected fixture factory", async () => {
    const state = input(); state.request.accepted.binding.endpoint = "https://127.0.0.1/v1";
    await expect(dispatchBoundModel(state.request)).rejects.toMatchObject({ code: "MODEL_NETWORK_PRIVATE_ADDRESS_DENIED", outcome: "rejected" });
    expect(state.resolveCredential).toHaveBeenCalledTimes(1);
  });
  it("sanitizes secret resolver errors without consulting ambient model credentials", async () => {
    const state = input(); state.resolveCredential.mockRejectedValueOnce(new Error("private-fixture-key"));
    await expect(dispatchBoundModel(state.request)).rejects.toMatchObject({ message: "MODEL_DISPATCH_FAILED", outcome: "rejected" });
    expect(state.activeConnections()).toBe(0);
  });
});

function officialRoute(protocol: ModelProtocol, providerId: string, endpoint: string): AcceptedModelDispatch {
  const route = accepted(protocol);
  route.definition = { ...route.definition, id: providerId, baseUrl: endpoint };
  route.model = { ...route.model, providerId };
  route.binding = { ...route.binding, providerId, endpoint, providerDefinitionDigest: requestDigest(route.definition) };
  return route;
}
describe("native input counter dispatch", () => {
  it.each([{tokens:3,status:200,code:null},{tokens:20000,status:200,code:"CONTEXT_LIMIT"},
    {tokens:3,status:429,code:"MODEL_COUNTER_RATE_LIMITED"},{tokens:null,status:200,code:"MODEL_COUNTER_RESPONSE_INVALID"}])("counts before generation and stops for $code", async ({tokens,status,code}) => {
    const state = input(officialRoute("openai_responses", "openai", "https://api.openai.com/v1"));
    const server = await fixture("openai_responses", undefined, 200, { status, body:{input_tokens:tokens} }, "https://api.openai.com");
    const counted = vi.fn(async () => {});
    const run = dispatchBoundModel({ ...state.request, beforePayloadDispatch: counted }, server.factory);
    if (code) await expect(run).rejects.toMatchObject({code,outcome:"rejected"});
    else { expect((await run).message.content).toBe("Hello"); expect(counted.mock.calls[0]![1]).toMatchObject({tokens:3,precision:"provider_count"}); }
    expect(server.calls.map(call=>call.path)).toEqual(code ? ["/v1/responses/input_tokens"] : ["/v1/responses/input_tokens","/v1/responses"]);
    expect(server.calls.every(call=>call.headers.authorization==="Bearer private-fixture-key")).toBe(true);
    expect(server.calls[0]!.body).toHaveProperty("input");
    expect(server.calls[0]!.body).not.toHaveProperty("max_output_tokens");
  });
  it("reauthorizes generation after counting instead of retaining counter authority", async () => {
    const state=input(officialRoute("openai_responses","openai","https://api.openai.com/v1"));
    state.resolveCredential.mockResolvedValueOnce("private-fixture-key").mockResolvedValueOnce("private-fixture-key").mockRejectedValue(new PlatformError("MODEL_CONNECTION_CHANGED",409,"Changed"));
    const server=await fixture("openai_responses",undefined,200,undefined,"https://api.openai.com");
    await expect(dispatchBoundModel(state.request,server.factory)).rejects.toMatchObject({outcome:"rejected"});
    expect(server.calls.map(call=>call.path)).toEqual(["/v1/responses/input_tokens"]);
  });
  it("refuses an unenforceable spending cap before any provider request", async () => {
    const state=input(); state.request.accepted.policy.maxCostMicros=100;
    const server=await fixture();
    await expect(dispatchBoundModel(state.request,server.factory)).rejects.toMatchObject({code:"MODEL_COST_CAP_UNSUPPORTED",outcome:"rejected"});
    expect(server.calls).toHaveLength(0);expect(state.resolveCredential).not.toHaveBeenCalled();
  });
  it("sends the pinned reviewed reasoning choice in the actual provider body", async () => {
    const route=officialRoute("openai_chat_completions","openrouter","https://openrouter.ai/api/v1");
    route.model.capabilities.reasoning={value:true,evidence:"discovered",source};
    route.model.reasoningOptions={efforts:["low","medium","high"],defaultEffort:"medium",defaultEnabled:true,mandatory:false,supportsMaxTokens:false,source};
    route.generation={reasoning:{kind:"effort",value:"high"}};route.generationRevision=modelControlsRevision;
    route.binding.generationDigest=requestDigest({generation:route.generation,revision:modelControlsRevision});
    const state=input(route),server=await fixture("openai_chat_completions",undefined,200,undefined,"https://openrouter.ai");
    await dispatchBoundModel(state.request,server.factory);
    expect(server.calls).toHaveLength(1);expect(server.calls[0]!.body.reasoning).toEqual({effort:"high"});
    expect(server.calls[0]!.body.provider).toEqual({allow_fallbacks:false,require_parameters:true});
  });
  it("counts private native input and tools with the correct official protocol, without assuming compatible endpoints support it", () => {
    const payload={model:"fixture-model",messages:[{role:"assistant",content:[{type:"thinking",thinking:"private",signature:"signed"}]}],system:"Instructions",tools:[{name:"lookup",input_schema:{type:"object"}}],thinking:{type:"adaptive"},stream:true,max_tokens:32};
    const anthropic=prepareInputCount(officialRoute("anthropic_messages","anthropic","https://api.anthropic.com/v1"),payload)!;
    expect(anthropic.url.pathname).toBe("/v1/messages/count_tokens");expect(anthropic.body).toMatchObject({messages:payload.messages,system:payload.system,tools:payload.tools,thinking:payload.thinking});
    expect(anthropic.body).not.toHaveProperty("stream");expect(anthropic.precision).toBe("provider_estimate");
    const google=prepareInputCount(officialRoute("google_generate_content","google","https://generativelanguage.googleapis.com/v1beta"),{contents:[{role:"model",parts:[{thoughtSignature:"signed"}]}],systemInstruction:{parts:[{text:"Instructions"}]},tools:[{functionDeclarations:[{name:"lookup"}]}]})!;
    expect(google.url.pathname).toBe("/v1beta/models/fixture-model:countTokens");expect(google.body).toHaveProperty("generateContentRequest.tools");
    expect(prepareInputCount(accepted("openai_responses"),payload)).toBeNull();
  });
});
