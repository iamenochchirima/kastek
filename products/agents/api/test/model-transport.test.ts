import { describe, expect, it, vi } from "vitest";
import { ModelNetworkError, createModelFetch } from "../src/infrastructure/model-network";
import { createServer } from "node:http";
import { callProviderModel, getBundledProviderModels, type ProviderTransportRequest } from "../src/adapters/models/pi-transport";

const request: ProviderTransportRequest = {
  provider: "fixture", protocol: "openai_chat_completions", model: "fixture-model",
  baseUrl: "https://fixture.invalid/v1", credentialRevision: "key-1", contextWindowTokens: 32000,
  maxOutputTokens: 32, messages: [{ role: "user", content: "Hello" }],
};
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (usage?: object) => new Response(sse({ id: "response-1", model: "fixture-model",
  choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], ...(usage ? { usage } : {}) }) + "data: [DONE]\n\n",
  { headers: { "Content-Type": "text/event-stream" } });
const fetcher = (fn: (body: any) => Response) => (async (_url: unknown, init: RequestInit) => fn(JSON.parse(String(init.body)))) as typeof fetch;

describe("native model transport", () => {
  it("sends system instructions and tool declarations through the pinned SDK context contract", async () => {
    let body: any;
    await callProviderModel({ ...request, messages: [{ role: "system", content: "Follow the approved policy." }, ...request.messages],
      tools: [{ type: "function", function: { name: "lookup", description: "Read a record", parameters: { type: "object", properties: {} } } }] },
    { apiKey: "fixture-key", fetch: fetcher(value => { body = value; return chat(); }) });
    expect(body.messages.some((message: any) => message.content === "Follow the approved policy.")).toBe(true);
    expect(body.tools[0].function.name).toBe("lookup");
  });
  it("requires a configured network policy and retains confirmed pre-dispatch rejection", async () => {
    await expect(callProviderModel(request, { apiKey: "fixture-key" })).rejects.toMatchObject({ code: "MODEL_NETWORK_POLICY_REQUIRED", outcome: "rejected" });
    let calls = 0;
    await expect(callProviderModel(request, { apiKey: "fixture-key", fetch: (async () => {
      calls++; throw new ModelNetworkError("AUTHORIZATION_DENIED", false);
    }) as typeof fetch })).rejects.toMatchObject({ code: "MODEL_NETWORK_AUTHORIZATION_DENIED", outcome: "rejected" });
    expect(calls).toBe(1);
  });
  it("verifies a capped payload before dispatch without allowing the hook to rewrite it", async () => {
    let prepared = false, body: any;
    const progress = vi.fn();
    await callProviderModel(request, { apiKey: "fixture-key", onProgress: progress,
      beforePayloadDispatch: async payload => { expect(payload.max_tokens).toBe(32); (payload as any).max_tokens = 999; prepared = true; },
      fetch: fetcher(value => { expect(prepared).toBe(true); body = value; return chat({ prompt_tokens: 9, completion_tokens: 2 }); }) });
    expect(body.max_tokens).toBe(32); expect(progress).toHaveBeenCalled();
  });
  it("streams an exact capped request, reports actual usage, and retains private native state", async () => {
    const bodies: any[] = [], deltas: string[] = [];
    const result = await callProviderModel(request, { apiKey: "fixture-key", onText: value => deltas.push(value),
      fetch: fetcher(body => { bodies.push(body); return chat({ prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }); }) });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toBe(32);
    expect(deltas.join("")).toBe("Hello");
    expect(result.message.content).toBe("Hello");
    expect(result.usage).toMatchObject({ observed: true, inputTokens: 9, outputTokens: 2 });
    expect(result.nativeState.credentialRevision).toBe("key-1");
    expect(JSON.stringify(result)).not.toContain("fixture-key");
  });

  it("forwards incremental response bytes and releases the original body reader on completion", async () => {
    let finish:()=>void=()=>{throw Error("Stream not started");},finished=false;
    const body=new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(new TextEncoder().encode(sse({id:"response-1",model:"fixture-model",choices:[{index:0,delta:{role:"assistant",content:"Hello"},finish_reason:null}]})));
      finish=()=>{
        finished=true;
        controller.enqueue(new TextEncoder().encode(sse({id:"response-1",model:"fixture-model",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:9,completion_tokens:2}})+"data: [DONE]\n\n"));
        controller.close();
      };
    }});
    const result=await callProviderModel(request,{apiKey:"fixture-key",fetch:fetcher(()=>new Response(body,{headers:{"Content-Type":"text/event-stream"}})),
      onText:()=>{expect(finished).toBe(false);finish();}});
    expect(result.message.content).toBe("Hello");
    expect(result.usage).toMatchObject({observed:true,inputTokens:9,outputTokens:2});
    expect(body.locked).toBe(false);
  });

  it("does not invent zero usage when the provider omits it", async () => {
    const result = await callProviderModel(request, { apiKey: "fixture-key", fetch: fetcher(() => chat()) });
    expect(result.usage).toEqual({ observed: false });
  });

  it.each([[400, "MODEL_REQUEST_INVALID"], [422, "MODEL_REQUEST_INVALID"], [401, "MODEL_AUTHENTICATION_FAILED"], [402, "MODEL_BILLING_REQUIRED"], [403, "MODEL_ACCESS_DENIED"],
    [404, "MODEL_UNAVAILABLE"], [429, "MODEL_RATE_LIMITED"]])("classifies HTTP %s as rejection without SDK retries", async (status, code) => {
    let calls = 0;
    await expect(callProviderModel(request, { apiKey: "fixture-key", fetch: fetcher(() => {
      calls++; return new Response(JSON.stringify({ error: { message: "fixture-key refused", type: "rate_limit" } }), { status: Number(status) });
    }) })).rejects.toMatchObject({ code, status, outcome: "rejected",diagnostics:{httpStatus:status,dispatched:true,stage:"provider_stream"} });
    expect(calls).toBe(1);
  });

  it("classifies an OpenRouter HTTP 503 as unavailable before generation, without replaying the request", async () => {
    let calls = 0;
    const text = vi.fn();
    await expect(callProviderModel({ ...request, provider: "openrouter" }, { apiKey: "fixture-key", onText: text,
      fetch: fetcher(() => { calls++; return new Response(JSON.stringify({ error: { code: 503, message: "No available provider" } }), { status: 503 }); }),
    })).rejects.toMatchObject({ code: "MODEL_PROVIDER_UNAVAILABLE", status: 503, outcome: "rejected",
      diagnostics: { httpStatus: 503, dispatched: true } });
    expect(calls).toBe(1);
    expect(text).not.toHaveBeenCalled();
  });

  it("classifies an explicit HTTP 503 from other providers as rejected, without replaying the request", async () => {
    let calls = 0;
    const text = vi.fn();
    await expect(callProviderModel({ ...request, provider: "nvidia" }, { apiKey: "fixture-key", onText: text,
      fetch: fetcher(() => { calls++; return new Response(JSON.stringify({ error: { message: "Service unavailable" } }), { status: 503 }); }),
    })).rejects.toMatchObject({ code: "MODEL_PROVIDER_UNAVAILABLE", status: 503, outcome: "rejected",
      diagnostics: { httpStatus: 503, dispatched: true } });
    expect(calls).toBe(1);
    expect(text).not.toHaveBeenCalled();
  });

  it("keeps an explicit HTTP 503 rejected when the provider error body is interrupted", async () => {
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":{"message":"PRIVATE_PROVIDER_DETAIL"}'));
      controller.error(new ModelNetworkError("NETWORK_UNAVAILABLE", true));
    } });
    const error = await callProviderModel(request, { apiKey: "fixture-key", fetch: fetcher(() => {
      calls++;
      return new Response(body, { status: 503, headers: { "content-type": "application/json" } });
    }) }).catch(error => error);
    expect(error).toMatchObject({ code: "MODEL_PROVIDER_UNAVAILABLE", status: 503, outcome: "rejected",
      diagnostics: { httpStatus: 503, stage: "response_body", dispatched: true } });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/PRIVATE_PROVIDER_DETAIL|fixture-key/);
    expect(calls).toBe(1);
  });

  it("classifies an HTTP 200 upstream 503 stream error as unavailable without replaying the request", async () => {
    let calls = 0;
    const deltas: string[] = [];
    const partial = sse({ id: "response-1", model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] });
    const upstreamFailure = sse({ error: { code: 503, message: "PRIVATE_PROVIDER_SECRET" } });
    const error = await callProviderModel(request, { apiKey: "fixture-key", onText: text => deltas.push(text), fetch: fetcher(() => {
      calls++; return new Response(partial + upstreamFailure, { headers: { "Content-Type": "text/event-stream" } });
    }) }).catch(error => error);
    expect(deltas.join("")).toBe("Partial");
    expect(error).toMatchObject({ code: "MODEL_PROVIDER_UNAVAILABLE", status: 503, outcome: "rejected",
      diagnostics: { httpStatus: 200, stage: "provider_stream", dispatched: true, streamErrorKind: "upstream_sse_error", providerErrorCode: 503 } });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/PRIVATE_PROVIDER_SECRET|fixture-key/);
    expect(calls).toBe(1);
  });

  it("keeps an unterminated HTTP 200 SSE 503 frame uncertain", async () => {
    let calls = 0;
    const truncated = `event: error\ndata: ${JSON.stringify({ error: { code: 503, message: "PRIVATE_TRUNCATED_PROVIDER_DETAIL" } })}\n`;
    const error = await callProviderModel(request, { apiKey: "fixture-key", fetch: fetcher(() => {
      calls++; return new Response(truncated, { headers: { "Content-Type": "text/event-stream" } });
    }) }).catch(error => error);
    expect(error).toMatchObject({ code: "MODEL_STREAM_FAILED", outcome: "uncertain" });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/PRIVATE_TRUNCATED_PROVIDER_DETAIL|fixture-key/);
    expect(calls).toBe(1);
  });

  it("preserves a stream 503 when response consumption exits before the SDK error event", async () => {
    let calls = 0;
    const partial = sse({ id: "response-1", model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] });
    const unavailable = sse({ error: { status: 503, message: "PRIVATE_PROVIDER_DETAIL" } });
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(partial + unavailable));
      controller.close();
    } });
    const error = await callProviderModel(request, { apiKey: "fixture-key", onText: () => { throw new Error("consumer stopped"); },
      fetch: fetcher(() => { calls++; return new Response(body, { headers: { "Content-Type": "text/event-stream" } }); }),
    }).catch(error => error);
    expect(error).toMatchObject({ code: "MODEL_PROVIDER_UNAVAILABLE", status: 503, outcome: "rejected",
      diagnostics: { httpStatus: 200, stage: "provider_stream", dispatched: true, streamErrorKind: "upstream_sse_error", providerErrorCode: 503 } });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/PRIVATE_PROVIDER_DETAIL|fixture-key/);
    expect(calls).toBe(1);
  });

  it.each(["provider_error", "incomplete"])("classifies HTTP 200 %s after partial output as uncertain stream failure without exposing provider details", async kind => {
    let calls = 0;
    const deltas: string[] = [];
    const partial = sse({ id: "response-1", model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "Partial" }, finish_reason: null }] });
    const tail = kind === "provider_error" ? sse({ error: { code: "temporary_failure", message: "PRIVATE_PROVIDER_SECRET", metadata: { raw: "PRIVATE_PROMPT" } } }) : "data: [DONE]\n\n";
    const error = await callProviderModel(request, { apiKey: "fixture-key", onText: text => deltas.push(text), fetch: fetcher(() => {
      calls++; return new Response(partial + tail, { headers: { "Content-Type": "text/event-stream" } });
    }) }).catch(error => error);
    expect(deltas.join("")).toBe("Partial");
    expect(error).toMatchObject({ code: "MODEL_STREAM_FAILED", status: 502, outcome: "uncertain" });
    expect(String(error) + JSON.stringify(error)).not.toMatch(/PRIVATE_PROVIDER_SECRET|PRIVATE_PROMPT|fixture-key/);
    expect(calls).toBe(1);
  });

  it("distinguishes bounded SSE failures without retaining private content or changing valid chunked bytes",async()=>{
    const privateValue="PRIVATE_PROVIDER_MESSAGE_Ω🙂",logged=vi.spyOn(console,"error").mockImplementation(()=>{});
    const fragmented=(wire:string)=>{const bytes=Buffer.from(wire);let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){
      if(offset===bytes.length){controller.close();return;}const end=Math.min(bytes.length,offset+17);controller.enqueue(bytes.subarray(offset,end));offset=end;
    }}),{headers:{"content-type":"text/event-stream"}});};
    try{
      const cases=[
        {wire:sse({error:{code:503,message:privateValue,metadata:{raw:"PRIVATE_REASONING"}}}),streamErrorKind:"upstream_sse_error",providerErrorCode:503},
        {wire:`event: error\r\ndata: {"code":429,\r\ndata: "message":"${privateValue}"}\r\n\r\n`,streamErrorKind:"upstream_sse_error",providerErrorCode:429},
        {wire:`data: {${privateValue}}\n\n`,streamErrorKind:"malformed_sse_json"},
        {wire:sse({error:{code:503,message:privateValue.repeat(2000)}}),streamErrorKind:"unclassified"},
        {wire:sse({error:{code:privateValue,message:privateValue}}),streamErrorKind:"upstream_sse_error"},
      ];
      for(const scenario of cases){
        let calls=0;
        const error=await callProviderModel(request,{apiKey:"fixture-key",fetch:fetcher(()=>{calls++;return fragmented(scenario.wire);})}).catch(error=>error);
        const explicitUnavailable=scenario.streamErrorKind==="upstream_sse_error"&&scenario.providerErrorCode===503;
        expect(error).toMatchObject({code:explicitUnavailable?"MODEL_PROVIDER_UNAVAILABLE":"MODEL_STREAM_FAILED",outcome:explicitUnavailable?"rejected":"uncertain",
          ...(explicitUnavailable?{status:503}:{}),diagnostics:{httpStatus:200,stage:"provider_stream",dispatched:true,streamErrorKind:scenario.streamErrorKind}});
        expect(error.diagnostics.providerErrorCode).toBe(scenario.providerErrorCode);
        expect(String(error)+JSON.stringify(error)).not.toMatch(/PRIVATE|fixture-key|Ω|🙂/);expect(calls).toBe(1);
      }
      const text="Unchanged Unicode Ω🙂",wire="\uFEFF: heartbeat\r\n\r\n"+sse({id:"response-1",model:"fixture-model",choices:[{index:0,delta:{role:"assistant",content:text},finish_reason:"stop"}],fixturePadding:".".repeat(20_000)})+"data: [DONE]\n\n";
      const result=await callProviderModel(request,{apiKey:"fixture-key",fetch:fetcher(()=>fragmented(wire))});expect(result.message.content).toBe(text);
      expect(JSON.stringify(logged.mock.calls)).not.toMatch(/PRIVATE|fixture-key|Ω|🙂/);
    }finally{logged.mockRestore();}
  });

  it("preserves the physical deadline after HTTP200 while the SDK consumes partial SSE output", async () => {
    let calls=0;
    const deltas:string[]=[];
    const server=createServer((_req,res)=>{
      calls++;
      res.writeHead(200,{"content-type":"text/event-stream"});
      res.write(sse({id:"response-1",model:"fixture-model",choices:[{index:0,delta:{role:"assistant",content:"Partial"},finish_reason:null}]}));
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const fetch=(async(url,init)=>createModelFetch({authorizeUrl:target=>target.href===baseUrl+"/chat/completions",
      maxRequestBytes:100_000,maxResponseBytes:100_000,deadlineAt:Date.now()+100,testLoopback:true})(url,init)) as typeof globalThis.fetch;
    try {
      const error=await callProviderModel({...request,baseUrl},{apiKey:"fixture-key",fetch,onText:text=>deltas.push(text)}).catch(error=>error);
      expect(deltas.join("")).toBe("Partial");
      expect(error).toMatchObject({code:"MODEL_NETWORK_DEADLINE",outcome:"uncertain"});
      expect(calls).toBe(1);
      expect(String(error)+JSON.stringify(error)).not.toContain("fixture-key");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });

  it("does not replace an initiating malformed provider stream with SDK reader cleanup cancellation",async()=>{
    let calls=0;
    const server=createServer((_req,res)=>{calls++;res.writeHead(200,{"content-type":"text/event-stream"});res.write("data: {PRIVATE_PROVIDER_BAD_JSON}\n\n");});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const fetch=(async(url,init)=>createModelFetch({authorizeUrl:target=>target.href===baseUrl+"/chat/completions",
      maxRequestBytes:100_000,maxResponseBytes:100_000,deadlineAt:Date.now()+1000,testLoopback:true})(url,init)) as typeof globalThis.fetch;
    try{
      const error=await callProviderModel({...request,baseUrl},{apiKey:"fixture-key",fetch}).catch(error=>error);
      expect(error).toMatchObject({code:"MODEL_STREAM_FAILED",outcome:"uncertain",diagnostics:{httpStatus:200,stage:"provider_stream",dispatched:true}});
      expect(calls).toBe(1);expect(String(error)+JSON.stringify(error)).not.toMatch(/PRIVATE_PROVIDER_BAD_JSON|fixture-key/);
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });

  it("preserves genuine caller cancellation during protected response-body reads",async()=>{
    const abort=new AbortController();
    const server=createServer((_req,res)=>{res.writeHead(200,{"content-type":"text/event-stream"});res.write(": heartbeat\n\n");setTimeout(()=>abort.abort(),20);});
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
    const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const fetch=(async(url,init)=>createModelFetch({authorizeUrl:target=>target.href===baseUrl+"/chat/completions",
      maxRequestBytes:100_000,maxResponseBytes:100_000,deadlineAt:Date.now()+1000,testLoopback:true})(url,init)) as typeof globalThis.fetch;
    try{
      await expect(callProviderModel({...request,baseUrl},{apiKey:"fixture-key",fetch,signal:abort.signal})).rejects.toMatchObject({
        code:"MODEL_CANCELLED",outcome:"uncertain",diagnostics:{httpStatus:200,stage:"provider_stream",dispatched:true}});
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });

  it("rejects repaired partial tool arguments instead of executing them", async () => {
    const body = sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function",
      function: { name: "lookup", arguments: '{"x":' } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n";
    await expect(callProviderModel(request, { apiKey: "fixture", fetch: fetcher(() => new Response(body,
      { headers: { "Content-Type": "text/event-stream" } })) })).rejects.toMatchObject({ outcome: "uncertain" });
  });

  it("uses exact Responses cap even below the library's minimum", async () => {
    let body: any;
    await callProviderModel({ ...request, protocol: "openai_responses", maxOutputTokens: 8 }, { apiKey: "fixture", fetch: fetcher(value => {
      body = value;
      return new Response(sse({ type: "response.created", response: { id: "response-1", model: "fixture-model" } }) +
        sse({ type: "response.output_item.added", output_index: 0, item: { id: "msg-1", type: "message", role: "assistant", content: [] } }) +
        sse({ type: "response.content_part.added", item_id: "msg-1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }) +
        sse({ type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "OK" }) +
        sse({ type: "response.completed", response: { id: "response-1", status: "completed", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, output: [] } }),
      { headers: { "Content-Type": "text/event-stream" } });
    }) });
    expect(body.max_output_tokens).toBe(8);
  });

  it("preserves Anthropic native thinking and tool continuation", async () => {
    const bodies: any[] = [];
    const event = (type: string, value: object) => `event: ${type}\n${sse({ type, ...value })}`;
    const fetch = fetcher(body => {
      bodies.push(body);
      return new Response(event("message_start", { message: { id: "anthropic-1", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 4 } } }) +
        event("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "private", signature: "opaque-signature" } }) +
        event("content_block_stop", { index: 0 }) +
        event("content_block_start", { index: 1, content_block: { type: "tool_use", id: "call-1", name: "lookup", input: {} } }) +
        event("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"id":"a"}' } }) +
        event("content_block_stop", { index: 1 }) +
        event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } }) + event("message_stop", {}),
      { headers: { "Content-Type": "text/event-stream" } });
    });
    const first = await callProviderModel({ ...request, protocol: "anthropic_messages" }, { apiKey: "fixture", fetch });
    expect(JSON.stringify(bodies[0])).not.toContain("cache_control");
    expect(first.usage).toMatchObject({ observed: true, inputTokens: 7, cachedInputTokens: 4 });
    expect(first.message.content).toBeNull();
    const next = { ...request, protocol: "anthropic_messages" as const,
      messages: [...request.messages, first.message, { role: "tool" as const, content: "found", tool_call_id: "call-1" }],
      nativeHistory: { 1: first.nativeState } };
    await callProviderModel(next, { apiKey: "fixture", fetch });
    expect(JSON.stringify(bodies[1])).toContain("opaque-signature");
    expect(JSON.stringify(bodies[1])).toContain("tool_result");
    await expect(callProviderModel({ ...next, credentialRevision: "key-2" }, { apiKey: "fixture", fetch }))
      .rejects.toMatchObject({ code: "MODEL_NATIVE_STATE_MISMATCH" });
    expect(bodies).toHaveLength(2);
  });

  it("cancels an open stream and rejects pre-cancelled calls without dispatch", async () => {
    const abort = new AbortController();
    let calls = 0;
    const bodies:ReadableStream[]=[];
    const fetch = (async (_url: unknown, init: RequestInit) => {
      calls++;
      const body=new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
        init.signal?.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
      } });
      bodies.push(body);
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    const running = callProviderModel(request, { apiKey: "fixture", fetch, signal: abort.signal });
    setTimeout(() => abort.abort(), 30);
    await expect(running).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
    await expect(callProviderModel(request, { apiKey: "fixture", fetch, signal: abort.signal }))
      .rejects.toMatchObject({ code: "MODEL_CANCELLED_BEFORE_DISPATCH" });
    expect(calls).toBe(1);
    expect(bodies.every(body=>!body.locked)).toBe(true);
  });

  it("rejects missing keys and missing protected Google transport before dispatch", async () => {
    await expect(callProviderModel(request, { apiKey: "" })).rejects.toMatchObject({ code: "MODEL_CONFIGURATION_INVALID" });
    await expect(callProviderModel({ ...request, protocol: "google_generate_content" }, { apiKey: "fixture" }))
      .rejects.toMatchObject({ code: "MODEL_NETWORK_POLICY_REQUIRED" });
  });

  it("uses Google's native function calls and retains opaque thought signatures", async () => {
    const bodies: any[] = [];
    const googleFetch = fetcher(body => {
      bodies.push(body);
      return new Response(sse({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "lookup", args: { id: "a" } }, thoughtSignature: "b3BhcXVlLWdvb2dsZQ==" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 } }),
      { headers: { "Content-Type": "text/event-stream" } });
    });
    {
      const google = { ...request, protocol: "google_generate_content" as const, baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
      const first = await callProviderModel(google, { apiKey: "fixture-key", fetch: googleFetch });
      expect(first.message.tool_calls?.[0]?.function.name).toBe("lookup");
      expect(first.usage).toMatchObject({ observed: true, inputTokens: 5, outputTokens: 3 });
      expect(bodies[0].generationConfig.maxOutputTokens).toBe(32);
      await callProviderModel({ ...google, messages: [...google.messages, first.message,
        { role: "tool", content: "found", tool_call_id: first.message.tool_calls![0]!.id }], nativeHistory: { 1: first.nativeState } }, { apiKey: "fixture-key", fetch: googleFetch });
      expect(JSON.stringify(bodies[1])).toContain("b3BhcXVlLWdvb2dsZQ==");
      expect(JSON.stringify(bodies[1])).toContain("functionResponse");
    }
  });

  it("rejects a completed empty response", async () => {
    await expect(callProviderModel(request, { apiKey: "fixture", fetch: fetcher(() => new Response(sse({
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    }) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } })) }))
      .rejects.toMatchObject({ code: "MODEL_EMPTY_RESPONSE" });
  });

  it.each([
    { prompt_tokens: 9, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -1 } },
    { prompt_tokens: 9, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: -1 } },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 2 },
  ])("rejects unsafe usage details and arithmetic", async usage => {
    await expect(callProviderModel(request, { apiKey: "fixture", fetch: fetcher(() => chat(usage)) }))
      .rejects.toMatchObject({ code: "MODEL_USAGE_INVALID" });
  });

  it("reads only exact-provider bundled metadata without network or credentials", async () => {
    const network = vi.fn(() => { throw new Error("No network allowed"); });
    vi.stubGlobal("fetch", network);
    try {
      const models = await getBundledProviderModels("anthropic");
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toMatchObject({ id: expect.any(String), contextWindow: expect.any(Number), maxTokens: expect.any(Number) });
      expect(models[0]).not.toHaveProperty("tools");
      expect(await getBundledProviderModels("unknown-provider-fixture")).toEqual([]);
      models[0]!.input.push("fixture-only");
      expect((await getBundledProviderModels("anthropic"))[0]!.input).not.toContain("fixture-only");
      expect(network).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("keeps explicit Google REST routing independent of ambient SDK backend flags", async () => {
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    try {
      const response = await callProviderModel({ ...request, protocol: "google_generate_content",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta" }, { apiKey: "fixture", fetch: fetcher(() => new Response(sse({
          candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }],
        }), { headers: { "content-type": "text/event-stream" } })) });
      expect(response.message.content).toBe("OK");
    } finally { vi.unstubAllEnvs(); }
  });
});
