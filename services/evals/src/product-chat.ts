import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import {
  appendInteractiveTurn,
  createInteractiveSession,
  getAgentRef,
  getInteractiveSession,
  getSandbox,
  type AgentRef,
  type InteractiveSession,
  type InteractiveSessionState,
  type InteractiveTurn,
} from "./store.js";
import { ownerRequest, readOwnerSession, type OwnerSession } from "./product-agents.js";

export interface ProductChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  taskId: string | null;
  sources: Array<Record<string, unknown>>;
}

export interface ProductChatResult {
  session: InteractiveSession;
  turn: InteractiveTurn;
  messages: ProductChatMessage[];
  productTaskState: string;
}

export class ProductChatError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductChatError";
  }
}

type Json = Record<string, any>;

const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "cancel_requested",
  "incomplete",
  "refused",
  "uncertain",
  "waiting_review",
  "waiting_authority",
]);

function fail(statusCode: number, code: string, message: string): never {
  throw new ProductChatError(statusCode, code, message);
}

function sessionState(value: unknown): InteractiveSessionState {
  const state = String(value ?? "");
  if (state === "completed") return "completed";
  if (["cancelled", "cancel_requested"].includes(state)) return "cancelled";
  if (["failed", "incomplete", "uncertain", "refused"].includes(state)) return "failed";
  if (["waiting_review", "waiting_authority"].includes(state)) return "waiting_review";
  return "active";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function messagesFrom(value: Json): ProductChatMessage[] {
  const messages = Array.isArray(value.messages) ? value.messages as Json[] : [];
  return messages
    .filter((message) =>
      typeof message.id === "string" &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.text === "string")
    .map((message) => ({
      id: String(message.id),
      role: message.role,
      text: String(message.text),
      createdAt: String(message.createdAt ?? new Date().toISOString()),
      taskId: typeof message.taskId === "string" ? message.taskId : null,
      sources: Array.isArray(message.sources) ? message.sources as Array<Record<string, unknown>> : [],
    }));
}

async function waitForTask(
  request: () => Promise<Json>,
  taskId: string,
  timeoutMs = 120_000,
): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await request();
    const task = (value.task ?? value) as Json;
    const state = String(task.state ?? "");
    if (terminal.has(state)) return value;
    if (Date.now() >= deadline) {
      fail(504, "product_task_timeout", `Product task ${taskId} did not settle in time`);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
}

async function growthMessages(
  session: OwnerSession,
  conversationId: string,
): Promise<ProductChatMessage[]> {
  const value = await ownerRequest(
    session,
    "kasitek_session",
    "GET",
    `/api/agents/conversations/${encodeURIComponent(conversationId)}`,
  );
  return messagesFrom(value);
}

async function agentsMessages(
  session: OwnerSession,
  conversationId: string,
): Promise<ProductChatMessage[]> {
  const value = await ownerRequest(
    session,
    "agents_session",
    "GET",
    `/api/organizations/${encodeURIComponent(session.organizationId)}/conversations/${encodeURIComponent(conversationId)}`,
  );
  return messagesFrom(value);
}

async function recordTurn(
  pool: Pool,
  sandboxId: string,
  agentRef: AgentRef,
  input: {
    sessionId?: string;
    conversationId: string;
    taskId: string;
    message: string;
    output: string;
    state: InteractiveSessionState;
  },
): Promise<{ session: InteractiveSession; turn: InteractiveTurn }> {
  if (input.sessionId) {
    const recorded = await appendInteractiveTurn(pool, sandboxId, input.sessionId, {
      productTaskId: input.taskId,
      inputDigest: digest(input.message),
      ...(input.output ? { outputDigest: digest(input.output) } : {}),
      state: input.state,
    });
    return { session: recorded.session, turn: recorded.turn };
  }
  const recorded = await createInteractiveSession(pool, sandboxId, {
    workspaceRefId: agentRef.workspaceRefId,
    agentRefId: agentRef.id,
    productConversationId: input.conversationId,
    productTaskId: input.taskId,
    inputDigest: digest(input.message),
    ...(input.output ? { outputDigest: digest(input.output) } : {}),
    state: input.state,
  });
  return { session: recorded.session, turn: recorded.turn };
}

async function growthChat(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRef: AgentRef,
  sessionId: string | undefined,
  message: string,
): Promise<ProductChatResult> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) fail(404, "not_found", "Sandbox not found");
  const session = await readOwnerSession(config, detail);
  let conversationId: string | undefined;
  if (sessionId) {
    const existing = await getInteractiveSession(pool, sandboxId, sessionId);
    if (!existing) fail(404, "session_not_found", "Session not found");
    if (existing.session.agentRefId !== agentRef.id) {
      fail(409, "session_agent_mismatch", "Session belongs to a different agent");
    }
    conversationId = existing.session.productConversationId;
  }
  if (!conversationId) {
    const created = await ownerRequest(session, "kasitek_session", "POST", "/api/agents/conversations", {
      requestId: randomUUID(),
      featureId: agentRef.productAgentId,
      title: message.slice(0, 120),
    });
    conversationId = String((created.conversation as Json | undefined)?.id ?? "");
    if (!conversationId) fail(502, "conversation_missing", "Growth did not return a conversation");
  }
  const sent = await ownerRequest(
    session,
    "kasitek_session",
    "POST",
    `/api/agents/conversations/${encodeURIComponent(conversationId)}/messages`,
    { requestId: randomUUID(), text: message },
  );
  const task = (sent.task ?? {}) as Json;
  const taskId = String(task.id ?? "");
  if (!taskId) fail(502, "task_missing", "Growth did not return a task");
  const settled = await waitForTask(
    () => ownerRequest(
      session,
      "kasitek_session",
      "GET",
      `/api/agents/tasks/${encodeURIComponent(taskId)}`,
    ),
    taskId,
  );
  const settledTask = (settled.task ?? {}) as Json;
  const messages = await growthMessages(session, conversationId);
  const output = messages.find((item) => item.role === "assistant" && item.taskId === taskId)?.text
    ?? String(settledTask.output ?? "");
  const recorded = await recordTurn(pool, sandboxId, agentRef, {
    sessionId,
    conversationId,
    taskId,
    message,
    output,
    state: sessionState(settledTask.state),
  });
  return {
    ...recorded,
    messages,
    productTaskState: String(settledTask.state ?? "unknown"),
  };
}

async function agentsChat(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRef: AgentRef,
  sessionId: string | undefined,
  message: string,
): Promise<ProductChatResult> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) fail(404, "not_found", "Sandbox not found");
  const session = await readOwnerSession(config, detail);
  const orgBase = `/api/organizations/${encodeURIComponent(session.organizationId)}`;
  let conversationId: string | undefined;
  if (sessionId) {
    const existing = await getInteractiveSession(pool, sandboxId, sessionId);
    if (!existing) fail(404, "session_not_found", "Session not found");
    if (existing.session.agentRefId !== agentRef.id) {
      fail(409, "session_agent_mismatch", "Session belongs to a different agent");
    }
    conversationId = existing.session.productConversationId;
  }
  const sent = await ownerRequest(session, "agents_session", "POST", `${orgBase}/tasks`, {
    agentId: agentRef.productAgentId,
    input: message,
    requestKey: randomUUID(),
    ...(conversationId ? { conversationId } : {}),
  });
  const task = (sent.task ?? {}) as Json;
  const taskId = String(task.id ?? "");
  if (!taskId) fail(502, "task_missing", "Agents did not return a task");
  const settled = await waitForTask(
    () => ownerRequest(
      session,
      "agents_session",
      "GET",
      `${orgBase}/tasks/${encodeURIComponent(taskId)}`,
    ),
    taskId,
  );
  const settledTask = (settled.task ?? {}) as Json;
  conversationId = conversationId ?? String(settledTask.conversationId ?? settledTask.conversation_id ?? "");
  if (!conversationId) fail(502, "conversation_missing", "Agents did not return a conversation");
  const messages = await agentsMessages(session, conversationId);
  const output = messages.find((item) => item.role === "assistant" && item.taskId === taskId)?.text
    ?? String(settledTask.output ?? "");
  const recorded = await recordTurn(pool, sandboxId, agentRef, {
    sessionId,
    conversationId,
    taskId,
    message,
    output,
    state: sessionState(settledTask.state),
  });
  return {
    ...recorded,
    messages,
    productTaskState: String(settledTask.state ?? "unknown"),
  };
}

export async function chatWithProductAgent(
  config: EvalsConfig,
  pool: Pool,
  input: {
    sandboxId: string;
    agentRefId: string;
    sessionId?: string;
    message: string;
  },
): Promise<ProductChatResult> {
  const detail = await getSandbox(pool, input.sandboxId);
  if (!detail) fail(404, "not_found", "Sandbox not found");
  if (detail.sandbox.status === "provisioning") {
    fail(409, "sandbox_provisioning", "Sandbox is still provisioning");
  }
  const agentRef = await getAgentRef(pool, input.sandboxId, input.agentRefId);
  if (!agentRef) fail(404, "agent_not_found", "Agent reference not found");
  if (detail.sandbox.product === "agents" && agentRef.productVersionId.startsWith("draft-")) {
    fail(409, "agent_not_published", "Publish the agent before chatting");
  }
  if (detail.sandbox.product === "growth") {
    return growthChat(config, pool, input.sandboxId, agentRef, input.sessionId, input.message);
  }
  if (detail.sandbox.product === "agents") {
    return agentsChat(config, pool, input.sandboxId, agentRef, input.sessionId, input.message);
  }
  fail(400, "unsupported_product", `Unsupported sandbox product: ${detail.sandbox.product}`);
}

export async function productMessages(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  sessionId: string,
): Promise<ProductChatMessage[]> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) fail(404, "not_found", "Sandbox not found");
  const existing = await getInteractiveSession(pool, sandboxId, sessionId);
  if (!existing) fail(404, "session_not_found", "Session not found");
  const session = await readOwnerSession(config, detail);
  if (detail.sandbox.product === "growth") {
    return growthMessages(session, existing.session.productConversationId);
  }
  if (detail.sandbox.product === "agents") {
    return agentsMessages(session, existing.session.productConversationId);
  }
  fail(400, "unsupported_product", `Unsupported sandbox product: ${detail.sandbox.product}`);
}
