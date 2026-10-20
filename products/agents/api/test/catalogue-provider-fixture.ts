import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

/** Controlled HTTP providers, never a substitute for live provider acceptance. */
export async function createCatalogueProviderFixture() {
  const calls: { kind: "mcp" | "api" | "resource" | "template" | "prompt"; input: unknown }[] = [];
  const state = { credential: "catalogue-initial-key", expired: false };
  const server = createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    const send = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.url === "/fixture/status") { send({ calls }); return; }
    if (request.url === "/fixture/expire" && request.method === "POST") { state.expired = true; send({ expired: true }); return; }
    if (request.url === "/fixture/reset" && request.method === "POST") { state.expired = false; state.credential = "catalogue-initial-key"; send({ reset: true }); return; }
    if (request.url === "/fixture/rotate" && request.method === "POST") { state.expired = false; state.credential = "catalogue-replacement-key"; send({ rotated: true }); return; }
    if (request.url === "/model") {
      const body = JSON.parse(text), lastUser = body.messages.findLastIndex((message: { role: string }) => message.role === "user");
      const current = body.messages.slice(lastUser + 1), result = current.findLast((message: { role: string }) => message.role === "tool");
      const requested = String(body.messages[lastUser]?.content ?? "").toLowerCase();
      const target = requested.includes("selected prompt") ? "controlled prompt" : requested.includes("selected template") ? "controlled template" : requested.includes("selected resource") ? "controlled resource" : null;
      const tool = body.tools?.find((item: { function: { description?: string } }) => item.function.description?.includes("Requires exact approval") && (!target || item.function.description.toLowerCase().includes(target)));
      const message = result ? { role: "assistant", content: "Controlled tool execution finished." } : tool ? { role: "assistant", content: null, tool_calls: [{ id: randomUUID(), type: "function", function: { name: tool.function.name, arguments: JSON.stringify(tool.function.parameters.properties?.name ? { name: "Acceptance" } : tool.function.parameters.properties?.question ? { question: "What is the approved reply?" } : {}) } }] } : { role: "assistant", content: "No connected tool is available." };
      send({ id: randomUUID(), choices: [{ finish_reason: result || !tool ? "stop" : "tool_calls", message }], usage: { prompt_tokens: 40, completion_tokens: 8 } }); return;
    }
    if (state.expired || request.headers.authorization !== `Bearer ${state.credential}`) { send({ error: "Controlled credential expired" }, 401); return; }
    if (request.url === "/mcp") {
      const body = JSON.parse(text), reply = (result: unknown) => send({ jsonrpc: "2.0", id: body.id, result });
      switch (body.method) {
        case "initialize": reply({ protocolVersion: "2025-11-25", capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "Controlled catalogue MCP", version: "1" } }); break;
        case "notifications/initialized": response.writeHead(202); response.end(); break;
        case "tools/list": reply({ tools: [{ name: "greet", description: "Return a controlled acceptance greeting.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } }] }); break;
        case "resources/list": reply({ resources: [{ uri: "docs://guide", name: "Acceptance guide", description: "Read a controlled resource.", mimeType: "text/plain" }] }); break;
        case "resources/templates/list": reply({ resourceTemplates: [{ uriTemplate: "docs://{team}/{document}", name: "Acceptance document", description: "Read a controlled template." }] }); break;
        case "prompts/list": reply({ prompts: [{ name: "approved_reply", description: "Use a controlled prompt.", arguments: [{ name: "question", required: true, description: "Question to answer" }] }] }); break;
        case "resources/read": calls.push({ kind: body.params.uri === "docs://guide" ? "resource" : "template", input: body.params }); reply({ contents: [{ uri: body.params.uri, mimeType: "text/plain", text: "Controlled approved resource content." }] }); break;
        case "prompts/get": calls.push({ kind: "prompt", input: body.params }); reply({ description: "Approved reply", messages: [{ role: "user", content: { type: "text", text: "Answer the approved question using controlled content." } }] }); break;
        case "tools/call": calls.push({ kind: "mcp", input: body.params }); reply({ content: [{ type: "text", text: "Hello Acceptance" }], isError: false }); break;
        default: send({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Method not found" } });
      }
      return;
    }
    if (request.url === "/greeting" && request.method === "GET") { calls.push({ kind: "api", input: {} }); send({ greeting: "Hello Acceptance" }); return; }
    send({ error: "Unknown controlled fixture endpoint" }, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, state,
    close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
