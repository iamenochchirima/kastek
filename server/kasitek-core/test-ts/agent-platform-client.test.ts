import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { readConfig } from "../src-ts/config.js";
import { AgentPlatformClient } from "../src-ts/services/agent-platform/client.js";
const config = () =>
  readConfig({
    DATABASE_URL: "postgres://unused",
    AGENTS_API_URL: "https://agents.synthetic.example",
    AGENTS_INTERNAL_AUTH_SECRET: "synthetic-signing-secret",
    AGENTS_INTERNAL_AUTH_AUDIENCE: "synthetic-agents",
    AGENTS_API_TIMEOUT_MS: "500",
  });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
test("native Agents transport preserves scoped HMAC claims, correlation, operator admission and the frozen adapter inventory", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new AgentPlatformClient(config(), {
    correlationId: () => "synthetic-correlation",
    now: () => 1700000000000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response('{"large":9223372036854775807}');
    },
  });
  assert.deepEqual(
    await client.createAgent("org", "user", {
      name: "synthetic",
      large: 9223372036854775807n,
    }),
    { large: 9223372036854775807n },
  );
  const init = calls[0]!.init,
    headers = init.headers as Record<string, string>;
  assert.equal(init.body, '{"large":9223372036854775807,"name":"synthetic"}');
  assert.equal(headers["x-organization-id"], "org");
  const [payload, signature] = headers.Authorization!.slice(7).split(".");
  assert.equal(
    signature,
    createHmac("sha256", "synthetic-signing-secret")
      .update(payload!)
      .digest("base64url"),
  );
  assert.deepEqual(JSON.parse(Buffer.from(payload!, "base64url").toString()), {
    organizationId: "org",
    actorId: "user",
    correlationId: "synthetic-correlation",
    audience: "synthetic-agents",
    expiresAt: 1700000060,
    scopes: ["agents:write"],
  });
  await client.operatorCreateCommand("operator", "synthetic-key", {
    action: "synthetic",
  });
  const operator = calls[1]!.init.headers as Record<string, string>;
  assert.equal(operator["x-kasitek-operator"], "true");
  assert.equal(operator["x-organization-id"], "platform");
  assert.equal(operator["idempotency-key"], "synthetic-key");
  const claims = JSON.parse(
    Buffer.from(
      operator.Authorization!.slice(7).split(".")[0]!,
      "base64url",
    ).toString(),
  );
  assert.equal(claims.operator, true);
  assert.deepEqual(claims.scopes, ["operator:write"]);
  const baseline = JSON.parse(
    readFileSync(
      new URL("./fixtures/rust-baseline-contracts.json", import.meta.url),
      "utf8",
    ),
  ) as { agentPlatformClientMethods: string[] };
  const expected = baseline.agentPlatformClientMethods;
  const actual = Object.getOwnPropertyNames(AgentPlatformClient.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  assert.equal(expected.length, 174);
  assert.deepEqual(actual, expected);
});
test("Agents filtering, OAuth error responses and multipart/audio contract preserve raw values and scopes", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let next = json({});
  const client = new AgentPlatformClient(config(), {
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return next;
    },
  });
  await client.listHandoffs(
    "org",
    "actor",
    " installation ",
    null,
    null,
    null,
    null,
    "unassigned",
    null,
    "!'()*",
    20,
    null,
    null,
  );
  assert.equal(
    calls[0]!.url,
    "https://agents.synthetic.example/v1/conversations/handoffs?installationId=%20installation%20&assignment=unassigned&search=%21%27%28%29%2A&limit=20",
  );
  next = json({ error: "denied", status: "error" }, 400);
  assert.deepEqual(
    await client.completeGoogleOAuthCallback("state=synthetic&code=a%2Fb"),
    { error: "denied", status: "error" },
  );
  assert.equal(
    calls[1]!.url,
    "https://agents.synthetic.example/v1/integrations/google/oauth/callback?state=synthetic&code=a%2Fb",
  );
  assert.equal(
    (calls[1]!.init.headers as Record<string, string>)["x-kasitek-oauth-proxy"],
    "1",
  );
  next = json({ transcript: "fixture" });
  await client.sendPlatformAudio(
    "org",
    "actor",
    "installation",
    Buffer.from("synthetic"),
    "audio/ogg",
    "voice.ogg",
    "synthetic-key",
    "conversation",
    "caption",
    null,
    null,
  );
  const sent = calls[2]!.init;
  const form = sent.body as FormData;
  const file = form.get("file") as File;
  assert.equal(file.name, "voice.ogg");
  assert.equal(file.type, "audio/ogg");
  assert.equal(await file.text(), "synthetic");
  assert.equal(
    (sent.headers as Record<string, string>)["x-audio-conversation-id"],
    "conversation",
  );
  assert.equal(
    (sent.headers as Record<string, string>)["Content-Type"],
    undefined,
  );
});
test("Agents upstream errors preserve reviewed codes and native stream bodies remain unbounded after connection", async () => {
  let next = json(
    { error: "provider missing", code: "google_oauth_not_configured" },
    503,
  );
  const client = new AgentPlatformClient(config(), { fetch: async () => next });
  await assert.rejects(client.getModelCatalog("org", "actor"), {
    status: 503,
    code: "google_oauth_not_configured",
    message: "provider missing",
  });
  next = json(
    { error: "operator conflict", code: "conversation_handoff_active" },
    400,
  );
  await assert.rejects(client.getModelCatalog("org", "actor"), {
    status: 409,
    code: "conversation_handoff_active",
  });
  next = json({ error: "not permitted" }, 401);
  await assert.rejects(client.getModelCatalog("org", "actor"), {
    status: 401,
    message: "Unauthorized",
  });
  next = new Response(null, { status: 204 });
  assert.equal(await client.getModelCatalog("org", "actor"), null);
  next = new Response("not-json");
  await assert.rejects(client.getModelCatalog("org", "actor"), {
    status: 502,
    message: "Agent Platform returned an invalid response",
  });
  let signal: AbortSignal | undefined;
  const streamClient = new AgentPlatformClient(config(), {
    fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: synthetic\n\n"));
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const streamed = await streamClient.streamRunEvents(
    "org",
    "actor",
    "run",
    18446744073709551615n,
  );
  const reader = streamed.body!.getReader();
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    "data: synthetic\n\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 525));
  assert.equal(signal!.aborted, false);
  await reader.cancel();
});

test("Agents JSON preserves explicit null bodies while bodyless adapters omit JSON", async () => {
  const bodies: unknown[] = [];
  const client = new AgentPlatformClient(config(), {
    fetch: async (_url, init) => {
      bodies.push(init?.body);
      return json({});
    },
  });
  await client.createAgent("org", "actor", null);
  await client.getModelCatalog("org", "actor");
  assert.deepEqual(bodies, ["null", undefined]);
});
test("Telegram bridge preserves forwarded secret headers and source service-unavailable mapping", async () => {
  let headers: Record<string, string> = {};
  const client = new AgentPlatformClient(config(), {
    fetch: async (_input, init) => {
      headers = init!.headers as Record<string, string>;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(
    await client.forwardTelegramWebhook("synthetic", "provider-secret", {
      update_id: 7,
    }),
    null,
  );
  assert.equal(
    headers["x-kasitek-core-forward-secret"],
    "synthetic-signing-secret",
  );
  assert.equal(headers["x-telegram-bot-api-secret-token"], "provider-secret");
  assert.equal(headers.Authorization, undefined);
  const unavailable = new AgentPlatformClient(config(), {
    fetch: async () => {
      throw Object.assign(new Error("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    },
  });
  await assert.rejects(
    unavailable.forwardTelegramWebhook("synthetic", null, {}),
    (error: unknown) => (error as { status: number }).status === 503,
  );
});
test("native SSE limits TCP connection only and permits delayed response headers and body", async () => {
  const { createServer } = await import("node:http");
  const { closeAgentStreamDispatchers } =
    await import("../src-ts/services/agent-platform/transport.js");
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      setTimeout(() => response.end("data: synthetic\n\n"), 650);
    }, 650);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const native = new AgentPlatformClient(
      readConfig({
        DATABASE_URL: "postgres://unused",
        AGENTS_API_URL: `http://127.0.0.1:${address.port}`,
        AGENTS_INTERNAL_AUTH_SECRET: "synthetic",
        AGENTS_API_TIMEOUT_MS: "500",
      }),
    );
    const response = await native.streamConversationFeedEvents(
      "synthetic",
      "synthetic",
    );
    assert.equal(await response.text(), "data: synthetic\n\n");
  } finally {
    await closeAgentStreamDispatchers();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test('native stream shutdown aborts an open upstream body instead of waiting for remote EOF',async()=>{
 const {createServer}=await import('node:http');
 const {closeAgentStreamDispatchers}=await import('../src-ts/services/agent-platform/transport.js');
 let closed!:()=>void;
 const disconnected=new Promise<void>(resolve=>{closed=resolve;});
 const server=createServer((_request,response)=>{
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.write('data: fixture\n\n');
  response.on('close',closed);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const native=new AgentPlatformClient(readConfig({DATABASE_URL:'postgres://unused',AGENTS_API_URL:`http://127.0.0.1:${(server.address() as {port:number}).port}`,AGENTS_INTERNAL_AUTH_SECRET:'fixture'}));
  const response=await native.streamConversationFeedEvents('synthetic','synthetic');
  const reader=response.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value),'data: fixture\n\n');
  const bounded=(promise:Promise<unknown>)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Stream shutdown did not disconnect upstream')),2000);timer.unref();})]);
  await bounded(closeAgentStreamDispatchers());
  await bounded(disconnected);
  await assert.rejects(reader.read());
  reader.releaseLock();
 }finally{
  await closeAgentStreamDispatchers();
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
 }
});
