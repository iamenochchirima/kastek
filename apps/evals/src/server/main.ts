import Fastify from "fastify";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type {
  AgentRef,
  InteractiveSession,
  OutcomeRef,
  SandboxDetail,
  SandboxSummary,
  ServiceHealth,
  SessionDetail,
  SessionSummary,
  OutcomeSummary,
} from "../../shared/types";

const appRoot = resolve(import.meta.dirname, "../..");
const serviceUrl = (process.env.EVALS_API_URL ?? "http://127.0.0.1:4600").replace(/\/+$/, "");
const operatorToken = process.env.EVALS_OPERATOR_TOKEN?.trim();

class ServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

type ServiceInit = RequestInit & { timeoutMs?: number };
async function service<T>(path: string, init: ServiceInit = {}): Promise<T> {
  if (!operatorToken) {
    throw new ServiceError(503, "EVALS_OPERATOR_TOKEN is not configured for the client server");
  }
  const { timeoutMs = 15_000, ...requestInit } = init;
  let response: Response;
  try {
    response = await fetch(`${serviceUrl}${path}`, {
      ...requestInit,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        ...(requestInit.body ? { "content-type": "application/json" } : {}),
        ...(requestInit.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ServiceError(502, `Evaluation service is unreachable at ${serviceUrl}`);
  }
  const raw = await response.text();
  let value: unknown = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value
      ? String((value as { error: unknown }).error)
      : `Evaluation service returned ${response.status}`;
    throw new ServiceError(response.status, error);
  }
  return value as T;
}

async function sandboxSummary(detail: Omit<SandboxDetail, "counts" | "agents" | "sessions" | "outcomes">): Promise<SandboxSummary> {
  const id = encodeURIComponent(detail.sandbox.id);
  const [agents, sessions, outcomes] = await Promise.all([
    service<{ agentRefs: AgentRef[] }>(`/v1/sandboxes/${id}/agents`),
    service<{ sessions: InteractiveSession[] }>(`/v1/sandboxes/${id}/sessions?limit=200`),
    service<{ outcomeRefs: OutcomeRef[] }>(`/v1/sandboxes/${id}/outcomes`),
  ]);
  return {
    ...detail,
    counts: {
      agents: agents.agentRefs.length,
      sessions: sessions.sessions.length,
      outcomes: outcomes.outcomeRefs.length,
    },
  };
}

async function sandboxDetail(sandboxId: string): Promise<SandboxDetail> {
  const id = encodeURIComponent(sandboxId);
  const [detail, agents, sessions, outcomes] = await Promise.all([
    service<Omit<SandboxDetail, "counts" | "agents" | "sessions" | "outcomes">>(`/v1/sandboxes/${id}`),
    service<{ agentRefs: AgentRef[] }>(`/v1/sandboxes/${id}/agents`),
    service<{ sessions: InteractiveSession[] }>(`/v1/sandboxes/${id}/sessions?limit=200`),
    service<{ outcomeRefs: OutcomeRef[] }>(`/v1/sandboxes/${id}/outcomes`),
  ]);
  return {
    ...detail,
    agents: agents.agentRefs,
    sessions: sessions.sessions,
    outcomes: outcomes.outcomeRefs,
    counts: {
      agents: agents.agentRefs.length,
      sessions: sessions.sessions.length,
      outcomes: outcomes.outcomeRefs.length,
    },
  };
}

async function listSandboxes(): Promise<SandboxSummary[]> {
  const value = await service<{ sandboxes: Array<Omit<SandboxDetail, "counts" | "agents" | "sessions" | "outcomes">> }>(
    "/v1/sandboxes?limit=200",
  );
  return Promise.all(
    value.sandboxes
      .filter((item) => item.sandbox.status !== "retired")
      .map(sandboxSummary),
  );
}

async function listSessions(): Promise<SessionSummary[]> {
  const sandboxes = await listSandboxes();
  const groups = await Promise.all(sandboxes.map(async (item) => {
    const value = await service<{ sessions: InteractiveSession[] }>(
      `/v1/sandboxes/${encodeURIComponent(item.sandbox.id)}/sessions?limit=200`,
    );
    return value.sessions.map((session) => ({ ...session, sandboxProduct: item.sandbox.product }));
  }));
  return groups.flat().sort((left, right) =>
    Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt));
}

async function listOutcomes(): Promise<OutcomeSummary[]> {
  const sandboxes = await listSandboxes();
  const groups = await Promise.all(sandboxes.map(async (item) => {
    const value = await service<{ outcomeRefs: OutcomeRef[] }>(
      `/v1/sandboxes/${encodeURIComponent(item.sandbox.id)}/outcomes`,
    );
    return value.outcomeRefs.map((outcome) => ({ ...outcome, sandboxProduct: item.sandbox.product }));
  }));
  return groups.flat().sort((left, right) =>
    Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

async function health(): Promise<ServiceHealth> {
  let reachable = false;
  let status = "unreachable";
  try {
    const response = await fetch(`${serviceUrl}/v1/health`, { signal: AbortSignal.timeout(3_000) });
    reachable = response.ok;
    status = response.ok ? (operatorToken ? "ready" : "operator-token-missing") : `http-${response.status}`;
  } catch {
    status = "unreachable";
  }
  return {
    ok: reachable && Boolean(operatorToken),
    service: "evals-client",
    version: "0.2.0",
    controlPlane: {
      url: serviceUrl,
      configured: Boolean(operatorToken),
      reachable,
      status,
    },
  };
}

const app = Fastify({ logger: false });

app.setErrorHandler((error, _request, reply) => {
  if (error instanceof ServiceError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }
  return reply.code(500).send({ error: error instanceof Error ? error.message : "Client request failed" });
});

app.get("/api/health", async () => health());
app.get("/api/sandboxes", async () => listSandboxes());
app.post("/api/sandboxes", async (request, reply) => {
  const body = request.body as { label?: unknown; workspaceName?: unknown; product?: unknown } | null;
  if (!body || typeof body.workspaceName !== "string" || !body.workspaceName.trim()) {
    return reply.code(400).send({ error: "workspaceName is required" });
  }
  const product = body.product === "growth" ? "growth" : "agents";
  const value = await service<SandboxDetail>("/v1/sandboxes", {
    method: "POST",
    body: JSON.stringify({
      product,
      provision: true,
      profile: "local",
      workspaceName: body.workspaceName.trim(),
      ...(typeof body.label === "string" && body.label.trim() ? { label: body.label.trim() } : {}),
    }),
  });
  return reply.code(202).send(value);
});
app.post("/api/sandboxes/:id/sync", async (request) => {
  const { id } = request.params as { id: string };
  const body = request.body as { confirm?: unknown } | null;
  if (!body || body.confirm !== "UPDATE") {
    throw new ServiceError(400, "Confirmation required");
  }
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/sync`, {
    method: "POST",
    timeoutMs: 600_000,
    body: JSON.stringify({ confirm: "UPDATE" }),
  });
});
app.post("/api/sandboxes/:id/mounted-sync", async (request) => {
  const { id } = request.params as { id: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/mounted-sync`, {
    method: "POST",
    timeoutMs: 120_000,
  });
});
app.post("/api/sandboxes/:id/runtime/restart", async (request) => {
  const { id } = request.params as { id: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/runtime/restart`, { method: "POST" });
});
app.get("/api/agent-templates", async () => service("/v1/agent-templates"));
app.get("/api/sandboxes/:id/agent-profiles", async (request) => {
  const { id } = request.params as { id: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/agent-profiles`);
});
app.post("/api/sandboxes/:id/agent-profiles", async (request) => {
  const { id } = request.params as { id: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/agent-profiles`, {
    method: "POST",
    body: JSON.stringify(request.body ?? {}),
  });
});
app.get("/api/agent-profiles/:profileId", async (request) => {
  const { profileId } = request.params as { profileId: string };
  return service(`/v1/agent-profiles/${encodeURIComponent(profileId)}`);
});
app.post("/api/agent-profiles/:profileId/versions", async (request) => {
  const { profileId } = request.params as { profileId: string };
  return service(`/v1/agent-profiles/${encodeURIComponent(profileId)}/versions`, {
    method: "POST",
    body: JSON.stringify(request.body ?? {}),
  });
});
app.post("/api/agent-profiles/:profileId/apply", async (request) => {
  const { profileId } = request.params as { profileId: string };
  return service(`/v1/agent-profiles/${encodeURIComponent(profileId)}/apply`, {
    method: "POST",
    body: JSON.stringify(request.body ?? {}),
  });
});
app.get("/api/sandboxes/:id/product-agents", async (request) => {
  const { id } = request.params as { id: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/product-agents`);
});
app.get("/api/sandboxes/:id/agents/:agentRefId", async (request) => {
  const { id, agentRefId } = request.params as { id: string; agentRefId: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}`);
});
app.get("/api/sandboxes/:id/agents/:agentRefId/models", async (request) => {
  const { id, agentRefId } = request.params as { id: string; agentRefId: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}/models`);
});
app.get("/api/sandboxes/:id/agents/:agentRefId/activity", async (request) => {
  const { id, agentRefId } = request.params as { id: string; agentRefId: string };
  const query = request.query as { taskId?: unknown };
  const suffix = typeof query.taskId === "string" && query.taskId
    ? `?taskId=${encodeURIComponent(query.taskId)}`
    : "";
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}/activity${suffix}`);
});
app.post("/api/sandboxes/:id/agents/:agentRefId/model", async (request) => {
  const { id, agentRefId } = request.params as { id: string; agentRefId: string };
  const body = request.body as { kind?: unknown; connectionId?: unknown; modelId?: unknown } | null;
  if (!body || (body.kind !== "organization_default" && body.kind !== "connection")) {
    throw new ServiceError(400, "A valid model selection is required");
  }
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}/model`, {
    method: "POST",
    body: JSON.stringify(body),
  });
});
app.post("/api/sandboxes/:id/chat", async (request) => {
  const { id } = request.params as { id: string };
  const body = request.body as { agentRefId?: unknown; message?: unknown; sessionId?: unknown } | null;
  if (!body || typeof body.agentRefId !== "string" || typeof body.message !== "string" || !body.message.trim()) {
    throw new ServiceError(400, "agentRefId and message are required");
  }
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/chat`, {
    method: "POST",
    timeoutMs: 180_000,
    body: JSON.stringify({
      agentRefId: body.agentRefId,
      message: body.message.trim(),
      ...(typeof body.sessionId === "string" && body.sessionId ? { sessionId: body.sessionId } : {}),
    }),
  });
});
app.get("/api/sandboxes/:id/sessions/:sessionId/messages", async (request) => {
  const { id, sessionId } = request.params as { id: string; sessionId: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/messages`);
});
app.delete("/api/sandboxes", async (request) => {
  const body = request.body as { confirm?: unknown } | null;
  if (!body || body.confirm !== "DELETE") {
    throw new ServiceError(400, "Confirmation required");
  }
  return service<{ deleted: string[]; failed: Array<{ id: string; error: string }> }>(
    "/v1/sandboxes",
    {
      method: "DELETE",
      body: JSON.stringify({ confirm: "DELETE" }),
    },
  );
});
app.delete("/api/sandboxes/:id", async (request) => {
  const { id } = request.params as { id: string };
  return service(`/v1/sandboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
});
app.get("/api/sandboxes/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  try {
    return await sandboxDetail(id);
  } catch (error) {
    if (error instanceof ServiceError && error.statusCode === 404) {
      return reply.code(404).send({ error: "Sandbox not found" });
    }
    throw error;
  }
});
app.get("/api/sandboxes/:id/sessions/:sessionId", async (request, reply) => {
  const { id, sessionId } = request.params as { id: string; sessionId: string };
  try {
    return await service<SessionDetail>(
      `/v1/sandboxes/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
    );
  } catch (error) {
    if (error instanceof ServiceError && error.statusCode === 404) {
      return reply.code(404).send({ error: "Session not found" });
    }
    throw error;
  }
});
app.get("/api/sessions", async () => listSessions());
app.get("/api/outcomes", async () => listOutcomes());

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

app.get("/*", async (request, reply) => {
  const url = request.url.split("?")[0] ?? "/";
  if (url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
  const web = join(appRoot, "dist", "web");
  let file = join(web, url === "/" ? "index.html" : url);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(web, "index.html");
  if (!existsSync(file)) {
    return reply.code(404).type("text/plain").send("Web client is not built. Run `pnpm build` or use the Vite dev server.");
  }
  return reply.type(mime[extname(file)] ?? "application/octet-stream").send(readFileSync(file));
});

const port = Number(process.env.PORT ?? 4321);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`evals client listening on http://${host}:${port} -> ${serviceUrl}`);
