import { createHash, randomUUID } from "node:crypto";
import type {
  AgentRef,
  InteractiveSession,
  InteractiveSessionDetail,
  InteractiveSessionState,
  InteractiveTurn,
  OutcomeRef,
  SandboxDetail,
  WorkspaceRef,
} from "../store.js";

export interface ProductApiConfig {
  baseUrl: string;
  origin: string;
  organizationId: string;
  session: string;
  sessionCookieName?: string;
}

export interface ControlPlaneConfig {
  apiUrl: string;
  operatorToken: string;
  sandboxId: string;
}

export interface InteractiveClientConfig {
  product: ProductApiConfig;
  controlPlane: ControlPlaneConfig;
}

export interface CreateSessionInput {
  agentRefId: string;
  message: string;
  requestKey?: string;
  pollTimeoutMs?: number;
}

export interface ContinueSessionInput {
  sessionId: string;
  message: string;
  requestKey?: string;
  pollTimeoutMs?: number;
}

export interface InteractiveTurnResult {
  session: InteractiveSession;
  turn: InteractiveTurn;
  task: ProductTaskDetail;
  evidence: ProductEvidence | null;
}

export interface TranscriptTurn {
  sequence: number;
  productTaskId: string;
  state: InteractiveSessionState;
  task: ProductTaskDetail;
  evidence: ProductEvidence | null;
}

export interface InteractiveTranscript {
  session: InteractiveSession;
  turns: TranscriptTurn[];
  conversationTasks: ProductTaskDetail[];
}

export interface InteractiveView {
  sandbox: SandboxDetail;
  agents: AgentRef[];
  sessions: InteractiveSession[];
  outcomes: OutcomeRef[];
}

export interface ProductTaskDetail {
  task: Record<string, any>;
  events?: Array<Record<string, any>>;
  operations?: Array<Record<string, any>>;
  [key: string]: unknown;
}

export interface ProductEvidence {
  state?: string;
  passages?: Array<Record<string, any>>;
  [key: string]: unknown;
}

export interface SavedOutcomeRecord {
  outcomeRef: OutcomeRef;
  enquiry: Record<string, any> | null;
  record: Record<string, any> | null;
}

export class InteractiveClientError extends Error {
  constructor(
    public readonly step: string,
    public readonly status: number | null,
    public readonly code: string | null,
    message: string,
  ) {
    super(`${step}: ${message}`);
    this.name = "InteractiveClientError";
  }
}

type Json = Record<string, any>;

const terminalStates = new Set([
  "completed",
  "failed",
  "cancelled",
  "incomplete",
  "refused",
  "uncertain",
  "waiting_review",
  "waiting_authority",
]);

const taskStateMap: Record<string, InteractiveSessionState> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  cancel_requested: "cancelled",
  incomplete: "failed",
  refused: "failed",
  uncertain: "failed",
  waiting_review: "waiting_review",
  waiting_authority: "waiting_review",
};

function taskState(value: unknown): InteractiveSessionState {
  return taskStateMap[String(value)] ?? "active";
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function outputOf(task: Record<string, any>): string {
  return text(task.output);
}

function conversationOf(task: Record<string, any>): string {
  return text(task.conversationId ?? task.conversation_id);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InteractiveSandboxClient {
  private readonly product: ProductApiConfig;
  private readonly controlPlane: ControlPlaneConfig;

  constructor(config: InteractiveClientConfig) {
    this.product = config.product;
    this.controlPlane = config.controlPlane;
  }

  private async productRequest(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    step: string,
  ): Promise<Json> {
    const cookieName = this.product.sessionCookieName ?? "agents_session";
    const response = await fetch(
      `${this.product.baseUrl.replace(/\/+$/, "")}${path}`,
      {
        method,
        headers: {
          origin: this.product.origin,
          cookie: `${cookieName}=${this.product.session}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const raw = await response.text();
    let value: Json = {};
    try {
      value = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      value = {};
    }
    if (!response.ok) {
      const error = value.error && typeof value.error === "object" ? value.error as Json : {};
      throw new InteractiveClientError(
        step,
        response.status,
        typeof error.code === "string" ? error.code : null,
        typeof error.message === "string" ? error.message : `HTTP ${response.status}`,
      );
    }
    return value;
  }

  private async controlRequest(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    step: string,
  ): Promise<Json> {
    const response = await fetch(
      `${this.controlPlane.apiUrl.replace(/\/+$/, "")}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.controlPlane.operatorToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const raw = await response.text();
    let value: Json = {};
    try {
      value = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      value = {};
    }
    if (!response.ok) {
      throw new InteractiveClientError(
        step,
        response.status,
        typeof value.code === "string" ? value.code : null,
        typeof value.error === "string" ? value.error : `HTTP ${response.status}`,
      );
    }
    return value;
  }

  private sandboxPath(): string {
    return `/v1/sandboxes/${encodeURIComponent(this.controlPlane.sandboxId)}`;
  }

  async sandbox(): Promise<SandboxDetail> {
    return (await this.controlRequest("GET", this.sandboxPath(), undefined, "read sandbox")) as unknown as SandboxDetail;
  }

  async listSandboxes(limit = 50): Promise<SandboxDetail[]> {
    const value = await this.controlRequest(
      "GET",
      `/v1/sandboxes?limit=${limit}`,
      undefined,
      "list sandboxes",
    );
    return (value.sandboxes ?? []) as SandboxDetail[];
  }

  async ensureWorkspaceRef(
    productWorkspaceId: string,
    label?: string,
  ): Promise<WorkspaceRef> {
    const detail = await this.sandbox();
    const existing = detail.workspaceRefs.find(
      (item) => item.productWorkspaceId === productWorkspaceId,
    );
    if (existing) return existing;
    const value = await this.controlRequest(
      "POST",
      `${this.sandboxPath()}/workspaces`,
      {
        productWorkspaceId,
        ...(label ? { label } : {}),
      },
      "record workspace reference",
    );
    return value.workspaceRef as WorkspaceRef;
  }

  async listAgents(): Promise<AgentRef[]> {
    const value = await this.controlRequest(
      "GET",
      `${this.sandboxPath()}/agents`,
      undefined,
      "list agents",
    );
    return (value.agentRefs ?? []) as AgentRef[];
  }

  async agent(agentRefId: string): Promise<AgentRef> {
    const value = await this.controlRequest(
      "GET",
      `${this.sandboxPath()}/agents/${encodeURIComponent(agentRefId)}`,
      undefined,
      "read agent reference",
    );
    return value.agentRef as AgentRef;
  }

  async listSessions(limit = 50): Promise<InteractiveSession[]> {
    const value = await this.controlRequest(
      "GET",
      `${this.sandboxPath()}/sessions?limit=${limit}`,
      undefined,
      "list sessions",
    );
    return (value.sessions ?? []) as InteractiveSession[];
  }

  async session(sessionId: string): Promise<InteractiveSessionDetail> {
    return (await this.controlRequest(
      "GET",
      `${this.sandboxPath()}/sessions/${encodeURIComponent(sessionId)}`,
      undefined,
      "read session",
    )) as unknown as InteractiveSessionDetail;
  }

  async listOutcomes(): Promise<OutcomeRef[]> {
    const value = await this.controlRequest(
      "GET",
      `${this.sandboxPath()}/outcomes`,
      undefined,
      "list outcomes",
    );
    return (value.outcomeRefs ?? []) as OutcomeRef[];
  }

  async savedOutcomeRecord(outcomeRefId: string): Promise<SavedOutcomeRecord> {
    const outcomes = await this.listOutcomes();
    const outcomeRef = outcomes.find((item) => item.id === outcomeRefId);
    if (!outcomeRef) {
      throw new InteractiveClientError(
        "read outcome",
        404,
        "OUTCOME_REF_NOT_FOUND",
        "Outcome reference not found",
      );
    }
    const orgBase = `/api/organizations/${encodeURIComponent(this.product.organizationId)}`;
    if (outcomeRef.kind !== "enquiry") {
      return { outcomeRef, enquiry: null, record: null };
    }
    const enquiry = await this.productRequest(
      "GET",
      `${orgBase}/enquiries/${encodeURIComponent(outcomeRef.productOutcomeId)}`,
      undefined,
      "read saved enquiry",
    );
    const record = await this.productRequest(
      "GET",
      `${orgBase}/customer-records/enquiries/${encodeURIComponent(outcomeRef.productOutcomeId)}`,
      undefined,
      "read saved customer record",
    );
    return {
      outcomeRef,
      enquiry: (enquiry.enquiry ?? enquiry) as Json,
      record: (record.enquiry ?? record) as Json,
    };
  }

  private async postTask(input: {
    agentId: string;
    message: string;
    requestKey: string;
    conversationId?: string;
    pollTimeoutMs?: number;
  }): Promise<ProductTaskDetail> {
    const created = await this.productRequest(
      "POST",
      `/api/organizations/${encodeURIComponent(this.product.organizationId)}/tasks`,
      {
        agentId: input.agentId,
        input: input.message,
        requestKey: input.requestKey,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      },
      "start chat",
    );
    const task = created.task as Json | undefined;
    if (!task?.id) {
      throw new InteractiveClientError(
        "start chat",
        null,
        "TASK_NOT_CREATED",
        "The product did not return a task",
      );
    }
    return this.waitForTask(String(task.id), input.pollTimeoutMs);
  }

  private async waitForTask(taskId: string, timeoutMs = 60_000): Promise<ProductTaskDetail> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const detail = (await this.productRequest(
        "GET",
        `/api/organizations/${encodeURIComponent(this.product.organizationId)}/tasks/${encodeURIComponent(taskId)}`,
        undefined,
        "read chat task",
      )) as ProductTaskDetail;
      const state = String(detail.task?.state ?? "");
      if (terminalStates.has(state)) return detail;
      if (Date.now() >= deadline) {
        throw new InteractiveClientError(
          "wait for chat",
          null,
          "TASK_TIMEOUT",
          `Task ${taskId} did not settle within ${timeoutMs}ms`,
        );
      }
      await sleep(200);
    }
  }

  async evidence(taskId: string): Promise<ProductEvidence | null> {
    try {
      return (await this.productRequest(
        "GET",
        `/api/organizations/${encodeURIComponent(this.product.organizationId)}/tasks/${encodeURIComponent(taskId)}/evidence`,
        undefined,
        "read task evidence",
      )) as ProductEvidence;
    } catch (error) {
      if (error instanceof InteractiveClientError && [404, 409, 503].includes(error.status ?? 0)) {
        return null;
      }
      throw error;
    }
  }

  private async recordSession(input: {
    agentRef: AgentRef;
    conversationId: string;
    task: ProductTaskDetail;
    message: string;
  }): Promise<{ session: InteractiveSession; turn: InteractiveTurn }> {
    const task = input.task.task;
    const output = outputOf(task);
    const value = await this.controlRequest(
      "POST",
      `${this.sandboxPath()}/sessions`,
      {
        workspaceRefId: input.agentRef.workspaceRefId,
        agentRefId: input.agentRef.id,
        productConversationId: input.conversationId,
        productTaskId: String(task.id),
        inputDigest: digest(input.message),
        ...(output ? { outputDigest: digest(output) } : {}),
        state: taskState(task.state),
      },
      "record session",
    );
    return {
      session: value.session as InteractiveSession,
      turn: value.turn as InteractiveTurn,
    };
  }

  private async recordTurn(input: {
    sessionId: string;
    task: ProductTaskDetail;
    message: string;
  }): Promise<{ session: InteractiveSession; turn: InteractiveTurn }> {
    const task = input.task.task;
    const output = outputOf(task);
    const value = await this.controlRequest(
      "POST",
      `${this.sandboxPath()}/sessions/${encodeURIComponent(input.sessionId)}/turns`,
      {
        productTaskId: String(task.id),
        inputDigest: digest(input.message),
        ...(output ? { outputDigest: digest(output) } : {}),
        state: taskState(task.state),
      },
      "record session turn",
    );
    return {
      session: value.session as InteractiveSession,
      turn: value.turn as InteractiveTurn,
    };
  }

  async startSession(input: CreateSessionInput): Promise<InteractiveTurnResult> {
    const agentRef = await this.agent(input.agentRefId);
    const task = await this.postTask({
      agentId: agentRef.productAgentId,
      message: input.message,
      requestKey: input.requestKey ?? randomUUID(),
      pollTimeoutMs: input.pollTimeoutMs,
    });
    const conversationId = conversationOf(task.task);
    if (!conversationId) {
      throw new InteractiveClientError(
        "record session",
        null,
        "CONVERSATION_MISSING",
        "The product task did not return a conversation id",
      );
    }
    const recorded = await this.recordSession({
      agentRef,
      conversationId,
      task,
      message: input.message,
    });
    return {
      ...recorded,
      task,
      evidence: await this.evidence(String(task.task.id)),
    };
  }

  async continueSession(input: ContinueSessionInput): Promise<InteractiveTurnResult> {
    const detail = await this.session(input.sessionId);
    const agentRef = await this.agent(detail.session.agentRefId);
    const task = await this.postTask({
      agentId: agentRef.productAgentId,
      message: input.message,
      requestKey: input.requestKey ?? randomUUID(),
      conversationId: detail.session.productConversationId,
      pollTimeoutMs: input.pollTimeoutMs,
    });
    const recorded = await this.recordTurn({
      sessionId: input.sessionId,
      task,
      message: input.message,
    });
    return {
      ...recorded,
      task,
      evidence: await this.evidence(String(task.task.id)),
    };
  }

  async conversation(conversationId: string): Promise<Json> {
    return this.productRequest(
      "GET",
      `/api/organizations/${encodeURIComponent(this.product.organizationId)}/conversations/${encodeURIComponent(conversationId)}`,
      undefined,
      "read conversation",
    );
  }

  async task(taskId: string): Promise<ProductTaskDetail> {
    return (await this.productRequest(
      "GET",
      `/api/organizations/${encodeURIComponent(this.product.organizationId)}/tasks/${encodeURIComponent(taskId)}`,
      undefined,
      "read task transcript",
    )) as ProductTaskDetail;
  }

  async transcript(sessionId: string): Promise<InteractiveTranscript> {
    const detail = await this.session(sessionId);
    const conversation = await this.conversation(detail.session.productConversationId);
    const turns: TranscriptTurn[] = [];
    for (const turn of detail.turns) {
      const task = await this.task(turn.productTaskId);
      turns.push({
        sequence: turn.sequence,
        productTaskId: turn.productTaskId,
        state: turn.state,
        task,
        evidence: await this.evidence(turn.productTaskId),
      });
    }
    return {
      session: detail.session,
      turns,
      conversationTasks: (conversation.tasks ?? []) as ProductTaskDetail[],
    };
  }

  async view(): Promise<InteractiveView> {
    const [sandbox, agents, sessions, outcomes] = await Promise.all([
      this.sandbox(),
      this.listAgents(),
      this.listSessions(),
      this.listOutcomes(),
    ]);
    return { sandbox, agents, sessions, outcomes };
  }
}
