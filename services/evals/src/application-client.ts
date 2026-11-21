/** Minimal bearer client for the Agents application API (`/v1`). */
export interface ApplicationEndpoint {
  baseUrl: string;
  credential: string;
}

export interface ApplicationAgentSummary {
  id: string;
  name: string;
}

export interface ApplicationAgentDetail extends ApplicationAgentSummary {
  draftRevision: number;
  version: { id: string; number: number; createdAt: string };
}

export interface ApplicationRunSnapshot {
  taskId: string;
  conversationId: string;
  state: string;
  errorCode: string | null;
  output: string | null;
  outputAvailability: string;
}

export class ApplicationApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationApiError";
  }
}

type Json = Record<string, any>;

export class ApplicationClient {
  private readonly baseUrl: string;
  private readonly credential: string;

  constructor(endpoint: ApplicationEndpoint) {
    this.baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
    this.credential = endpoint.credential;
  }

  private async request(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<Json> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.credential}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ApplicationApiError(
        503,
        "application_unreachable",
        `The application API at ${this.baseUrl} did not respond`,
      );
    }
    const raw = await response.text();
    let value: Json = {};
    try {
      value = raw ? (JSON.parse(raw) as Json) : {};
    } catch {
      value = {};
    }
    if (!response.ok) {
      const nested = value.error && typeof value.error === "object"
        ? value.error as Json
        : null;
      throw new ApplicationApiError(
        response.status,
        String(nested?.code ?? value.code ?? `http_${response.status}`),
        String(nested?.message ?? value.error ?? `HTTP ${response.status}`),
      );
    }
    return value;
  }

  async listAgents(): Promise<ApplicationAgentSummary[]> {
    const value = await this.request("GET", "/v1/agents");
    const agents = Array.isArray(value.agents) ? value.agents as Json[] : [];
    return agents
      .filter((agent) => typeof agent.id === "string" && typeof agent.name === "string")
      .map((agent) => ({ id: String(agent.id), name: String(agent.name) }));
  }

  async inspectAgent(agentId: string): Promise<ApplicationAgentDetail> {
    const value = await this.request(
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}`,
    );
    const agent = value.agent as Json | undefined;
    if (!agent?.id || !agent.version?.id) {
      throw new ApplicationApiError(
        502,
        "invalid_response",
        "The application API returned an invalid agent",
      );
    }
    return {
      id: String(agent.id),
      name: String(agent.name),
      draftRevision: Number(agent.draftRevision ?? 0),
      version: {
        id: String(agent.version.id),
        number: Number(agent.version.number ?? 0),
        createdAt: String(agent.version.createdAt ?? ""),
      },
    };
  }

  async createAgent(input: {
    name: string;
    purpose?: string;
    instructions: string;
    operationId: string;
  }): Promise<ApplicationAgentSummary & { draftRevision: number }> {
    const value = await this.request("POST", "/v1/agents", input);
    const agent = value.agent as Json | undefined;
    if (!agent?.id) {
      throw new ApplicationApiError(
        502,
        "invalid_response",
        "The application API did not return the created agent",
      );
    }
    return {
      id: String(agent.id),
      name: String(agent.name),
      draftRevision: Number(agent.draftRevision ?? 1),
    };
  }

  async previewAgent(
    agentId: string,
    configuration: unknown,
  ): Promise<{ ready: boolean; errors: Array<{ code: string; message: string }> }> {
    const value = await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(agentId)}/preview`,
      { configuration },
    );
    const errors = Array.isArray(value.errors) ? value.errors as Json[] : [];
    return {
      ready: Boolean(value.ready),
      errors: errors.map((error) => ({
        code: String(error.code ?? "invalid_configuration"),
        message: String(error.message ?? "Check the configuration"),
      })),
    };
  }

  async updateAgent(
    agentId: string,
    input: { configuration: unknown; expectedRevision: number },
  ): Promise<{ id: string; name: string; draftRevision: number }> {
    const value = await this.request(
      "PATCH",
      `/v1/agents/${encodeURIComponent(agentId)}`,
      input,
    );
    const agent = value.agent as Json | undefined;
    if (!agent?.id) {
      throw new ApplicationApiError(
        502,
        "invalid_response",
        "The application API did not return the updated agent",
      );
    }
    return {
      id: String(agent.id),
      name: String(agent.name),
      draftRevision: Number(agent.draftRevision ?? input.expectedRevision + 1),
    };
  }

  async publishAgent(
    agentId: string,
    expectedRevision: number,
  ): Promise<{ id: string; number: number; createdAt: string }> {
    const value = await this.request(
      "POST",
      `/v1/agents/${encodeURIComponent(agentId)}/versions`,
      { expectedRevision },
    );
    const version = value.version as Json | undefined;
    if (!version?.id) {
      throw new ApplicationApiError(
        502,
        "invalid_response",
        "The application API did not return the published version",
      );
    }
    return {
      id: String(version.id),
      number: Number(version.number ?? 0),
      createdAt: String(version.createdAt ?? ""),
    };
  }

  async startRun(input: {
    agentId: string;
    message: string;
    requestId: string;
    conversationId?: string;
  }): Promise<ApplicationRunSnapshot> {
    const value = await this.request("POST", "/v1/runs", input);
    return {
      taskId: String(value.taskId ?? ""),
      conversationId: String(value.conversationId ?? ""),
      state: String(value.state ?? "accepted"),
      errorCode: null,
      output: null,
      outputAvailability: "pending",
    };
  }

  async getRun(taskId: string): Promise<ApplicationRunSnapshot> {
    const value = await this.request(
      "GET",
      `/v1/runs/${encodeURIComponent(taskId)}`,
    );
    return {
      taskId: String(value.taskId ?? taskId),
      conversationId: String(value.conversationId ?? ""),
      state: String(value.state ?? "unknown"),
      errorCode: value.errorCode == null ? null : String(value.errorCode),
      output: typeof value.output === "string" ? value.output : null,
      outputAvailability: String(value.outputAvailability ?? "unknown"),
    };
  }
}

export function normalizeApplicationUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApplicationApiError(400, "invalid_base_url", "Use an http or https URL");
  }
  if (url.username || url.password) {
    throw new ApplicationApiError(400, "invalid_base_url", "Do not put credentials in the URL");
  }
  return url.toString().replace(/\/+$/, "");
}
