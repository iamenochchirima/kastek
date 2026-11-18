import { randomUUID } from "node:crypto";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runIndependentClient } from "../../examples/independent-client/client.mjs";

type Json = Record<string, unknown>;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("independent application client", () => {
  it("creates, assigns a fixture tool, publishes, binds and invokes a generic agent", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const agentId = randomUUID(), versionId = randomUUID(), conversationId = randomUUID();
    const taskId = randomUUID(), deploymentId = randomUUID(), bindingId = randomUUID();
    let reads = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input), path = new URL(url).pathname, method = init.method ?? "GET";
      calls.push({ url, init });
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "POST" && path === "/v1/agents") return json(201, { agent: { id: agentId, name: body.name } });
      if (method === "PATCH" && path === `/v1/agents/${agentId}`) return json(200, { agent: { id: agentId, name: "Independent client agent", draftRevision: 2 } });
      if (method === "POST" && path === `/v1/agents/${agentId}/preview`) return json(200, { ready: true, errors: [] });
      if (method === "POST" && path === `/v1/agents/${agentId}/versions`) return json(201, { version: { id: versionId, number: 1, createdAt: new Date().toISOString() } });
      if (method === "POST" && path === `/v1/agents/${agentId}/deployments`) return json(201, { deployment: { id: deploymentId, versionId, allowedOrigins: body.allowedOrigins, publishedAt: new Date().toISOString() } });
      if (method === "POST" && path === "/v1/runs") return json(202, { taskId, conversationId, state: "accepted", replayed: false });
      if (method === "GET" && path === `/v1/runs/${taskId}`) {
        reads++;
        return json(200, reads === 1 ? { taskId, conversationId, state: "running", errorCode: null, output: null }
          : { taskId, conversationId, state: "completed", errorCode: null, output: "Fixture answer" });
      }
      if (method === "GET" && path === `/v1/runs/${taskId}/pending`) return json(200, { taskId, state: "completed", pending: [] });
      if (method === "GET" && path === `/v1/runs/${taskId}/events`)
        return new Response(`event: snapshot\ndata: ${JSON.stringify({ taskId, conversationId, state: "completed", output: "Fixture answer" })}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } });
      return json(404, { code: "NOT_FOUND" });
    }) as typeof fetch;

    const result = await runIndependentClient({ baseUrl: "https://agents.example", credential: "kat_test_credential",
      fixtureBindingId: bindingId, agentName: "Independent client agent", purpose: "Fixture purpose",
      instructions: "Fixture instructions", message: "Use the fixture tool", allowedOrigins: ["https://client.example"],
      fetch: fetchImpl, pollMs: 1, timeoutMs: 5000 });

    expect(result.agent).toMatchObject({ id: agentId, versionId, number: 1 });
    expect(result.deployment).toMatchObject({ id: deploymentId, versionId });
    expect(result.run).toMatchObject({ taskId, state: "completed", output: "Fixture answer" });
    expect(result.pending).toEqual([]);
    expect(result.activity).toMatchObject({ taskId, state: "completed", output: "Fixture answer" });
    expect(result.transcript.map(entry => `${entry.method} ${entry.path}`)).toEqual([
      "POST /v1/agents", `PATCH /v1/agents/${agentId}`, `POST /v1/agents/${agentId}/preview`,
      `POST /v1/agents/${agentId}/versions`, `POST /v1/agents/${agentId}/deployments`, "POST /v1/runs",
      `GET /v1/runs/${taskId}`, `GET /v1/runs/${taskId}`, `GET /v1/runs/${taskId}/pending`,
    ]);
    for (const call of calls) expect((call.init.headers as Record<string, string>).authorization).toBe("Bearer kat_test_credential");
    const create = JSON.parse(String(calls[0]!.init.body));
    expect(create).toMatchObject({ name: "Independent client agent", purpose: "Fixture purpose", instructions: "Fixture instructions" });
    expect(create.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const patch = JSON.parse(String(calls[1]!.init.body));
    expect(patch).toMatchObject({ expectedRevision: 1, configuration: { connectedToolBindingIds: [bindingId] } });
    expect(JSON.parse(String(calls[3]!.init.body))).toMatchObject({ expectedRevision: 2 });
    expect(JSON.parse(String(calls[4]!.init.body))).toMatchObject({ versionId, allowedOrigins: ["https://client.example"] });
    const run = JSON.parse(String(calls[5]!.init.body));
    expect(run).toMatchObject({ agentId, message: "Use the fixture tool" });
    expect(run.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.assertion).toBeUndefined();
  });

  it("signs a delegated-user assertion when a private key is supplied", async () => {
    const applicationId = randomUUID(), organizationId = randomUUID();
    const { privateKey } = generateKeyPairSync("ed25519");
    const agentId = randomUUID(), versionId = randomUUID(), taskId = randomUUID();
    const calls: Array<{ path: string; body: Json }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input)).pathname, method = init.method ?? "GET", body = init.body ? JSON.parse(String(init.body)) : {};
      calls.push({ path, body });
      if (method === "POST" && path === "/v1/agents") return json(201, { agent: { id: agentId, name: "Delegation client" } });
      if (method === "PATCH") return json(200, { agent: { id: agentId, draftRevision: 2 } });
      if (method === "POST" && path.endsWith("/preview")) return json(200, { ready: true, errors: [] });
      if (method === "POST" && path.endsWith("/versions")) return json(201, { version: { id: versionId, number: 1, createdAt: new Date().toISOString() } });
      if (method === "POST" && path.endsWith("/deployments")) return json(201, { deployment: { id: randomUUID(), versionId, allowedOrigins: ["https://client.example"], publishedAt: new Date().toISOString() } });
      if (method === "POST" && path === "/v1/runs") return json(202, { taskId, conversationId: randomUUID(), state: "accepted", replayed: false });
      if (method === "GET" && path === `/v1/runs/${taskId}`) return json(200, { taskId, state: "completed", output: "Delegated answer" });
      if (method === "GET" && path.endsWith("/pending")) return json(200, { taskId, pending: [] });
      if (method === "GET" && path.endsWith("/events")) return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
      return json(404, {});
    }) as typeof fetch;
    await runIndependentClient({ baseUrl: "https://agents.example", credential: "kat_delegated_credential",
      fixtureBindingId: randomUUID(), agentName: "Delegation client", instructions: "Fixture", message: "Delegate",
      allowedOrigins: ["https://client.example"], fetch: fetchImpl, pollMs: 1, timeoutMs: 5000,
      delegated: { applicationId, organizationId, subject: "user-42", audience: "https://agents.example" },
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const run = calls.find(call => call.path === "/v1/runs")!.body;
    const assertion = String(run.assertion), [payload] = assertion.split(".");
    expect(assertion.split(".")).toHaveLength(2);
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ applicationId, organizationId, subject: "user-42", audience: "https://agents.example" });
  });
});
