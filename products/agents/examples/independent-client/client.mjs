#!/usr/bin/env node
/**
 * Minimal independent Agents client. It imports nothing from the Agents source tree and talks
 * only to the documented application HTTP API with an application credential.
 */
import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const terminal = new Set(["completed", "incomplete", "refused", "failed", "cancelled", "uncertain"]);

function signedAssertion({ applicationId, organizationId, subject, audience, privateKeyPem }) {
  const now = Date.now();
  const payload = { applicationId, organizationId, subject, audience,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 120_000).toISOString() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(encoded), createPrivateKey(privateKeyPem)).toString("base64url");
  return `${encoded}.${signature}`;
}

async function readActivity({ fetchImpl, baseUrl, secret, taskId, timeoutMs = 10_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}/v1/runs/${taskId}/events`, {
      headers: { authorization: `Bearer ${secret}`, accept: "text/event-stream" }, signal: controller.signal });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) continue;
      const frame = buffer.slice(0, boundary), data = frame.split("\n").find(line => line.startsWith("data:"));
      controller.abort();
      return data ? JSON.parse(data.slice(5).trim()) : null;
    }
  } catch { return null; } finally { clearTimeout(timer); controller.abort(); }
}

export async function runIndependentClient(options) {
  const baseUrl = options.baseUrl.replace(/\/$/, ""), secret = options.credential;
  const fetchImpl = options.fetch ?? fetch;
  const transcript = [];
  const request = async (method, path, body) => {
    const response = await fetchImpl(`${baseUrl}${path}`, { method,
      headers: { authorization: `Bearer ${secret}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let value; try { value = text ? JSON.parse(text) : null; } catch { value = text; }
    transcript.push({ method, path, status: response.status });
    if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${typeof value === "string" ? value : JSON.stringify(value)}`);
    return value;
  };
  const configuration = JSON.parse(await readFile(options.configurationPath ?? join(here, "generic-agent.json"), "utf8"));
  const created = await request("POST", "/v1/agents", { name: options.agentName, purpose: options.purpose,
    instructions: options.instructions, operationId: randomUUID() });
  const agentId = created.agent.id;
  if (!options.fixtureBindingId && !options.fixtureTool) throw new Error("fixtureBindingId or fixtureTool is required");
  const assigned = { ...configuration, ...(options.fixtureBindingId
    ? { connectedToolBindingIds: [options.fixtureBindingId] }
    : { tools: [...new Set([...(configuration.tools ?? []), options.fixtureTool])] }) };
  const updated = await request("PATCH", `/v1/agents/${agentId}`, { configuration: assigned, expectedRevision: 1 });
  const preview = await request("POST", `/v1/agents/${agentId}/preview`, { configuration: assigned });
  if (!preview.ready) throw new Error(`Configuration is not ready: ${JSON.stringify(preview.errors)}`);
  const version = (await request("POST", `/v1/agents/${agentId}/versions`, { expectedRevision: updated.agent.draftRevision })).version;
  const deployment = (await request("POST", `/v1/agents/${agentId}/deployments`,
    { versionId: version.id, allowedOrigins: options.allowedOrigins })).deployment;
  const assertion = options.delegated && options.privateKeyPem
    ? signedAssertion({ ...options.delegated, privateKeyPem: options.privateKeyPem }) : undefined;
  const started = await request("POST", "/v1/runs", { agentId, message: options.message, requestId: randomUUID(),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}), ...(assertion ? { assertion } : {}) });
  let snapshot = started;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (!terminal.has(snapshot.state) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1_000));
    snapshot = await request("GET", `/v1/runs/${started.taskId}`);
  }
  if (!terminal.has(snapshot.state)) throw new Error(`Run ${started.taskId} did not settle before the timeout`);
  const pending = await request("GET", `/v1/runs/${started.taskId}/pending`);
  const activity = options.readActivity === false ? null
    : await readActivity({ fetchImpl, baseUrl, secret, taskId: started.taskId });
  return { agent: { id: agentId, versionId: version.id, number: version.number }, deployment,
    run: { taskId: started.taskId, conversationId: started.conversationId, state: snapshot.state,
      output: snapshot.output ?? null, errorCode: snapshot.errorCode ?? null },
    pending: pending.pending, activity, transcript };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const values = process.env;
  const result = await runIndependentClient({ baseUrl: values.AGENTS_URL, credential: values.AGENTS_APPLICATION_CREDENTIAL,
    fixtureBindingId: values.AGENTS_FIXTURE_TOOL_BINDING, fixtureTool: values.AGENTS_FIXTURE_TOOL, agentName: values.AGENTS_AGENT_NAME ?? "Independent client agent",
    purpose: values.AGENTS_AGENT_PURPOSE ?? "Answer questions with the assigned fixture tool.",
    instructions: values.AGENTS_AGENT_INSTRUCTIONS, message: values.AGENTS_MESSAGE ?? "Use the fixture tool and report the result.",
    allowedOrigins: (values.AGENTS_ALLOWED_ORIGINS ?? "https://client.example").split(",").map(value => value.trim()),
    configurationPath: values.AGENTS_CONFIGURATION_PATH, delegated: values.AGENTS_DELEGATED_SUBJECT ? {
      applicationId: values.AGENTS_APPLICATION_ID, organizationId: values.AGENTS_ORGANIZATION_ID,
      subject: values.AGENTS_DELEGATED_SUBJECT, audience: values.AGENTS_URL } : undefined,
    privateKeyPem: values.AGENTS_DELEGATED_PRIVATE_KEY });
  console.log(JSON.stringify(result, null, 2));
}
