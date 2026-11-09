import { randomUUID } from "node:crypto";

export interface SandboxSetupInput {
  baseUrl: string;
  origin: string;
  organizationId: string;
  ownerSession: string;
  sessionCookieName?: string;
  model: {
    providerId: string;
    name: string;
    apiKey: string;
    modelId: string;
  };
  knowledge: {
    title: string;
    content: string;
    visibility?: "private" | "public";
  };
  agent: {
    name: string;
    configuration: Record<string, unknown>;
    instructions: string;
    rootTokenLimit?: number;
    responsibilities?: Array<"answer-questions" | "customer-support" | "bookings" | "enquiries">;
  };
  website?: {
    allowedOrigins: string[];
  };
  member: {
    email: string;
    session: string;
  };
  controlPlane?: {
    apiUrl: string;
    operatorToken: string;
    sandboxId: string;
    workspaceRefId: string;
  };
}

export interface SandboxSetupResult {
  modelConnectionId: string;
  modelId: string;
  knowledgeJobId: string;
  sourceId: string;
  sourceRevisionId: string;
  agentId: string;
  versionId: string;
  compositionDigest: string;
  modelRoutesDigest: string;
  memberAccountId: string;
  deploymentId: string | null;
  agentRefId: string | null;
  steps: string[];
}

export class SandboxSetupError extends Error {
  constructor(
    public readonly step: string,
    public readonly status: number | null,
    public readonly code: string | null,
    message: string,
  ) {
    super(`${step}: ${message}`);
    this.name = "SandboxSetupError";
  }
}

type Json = Record<string, any>;

function bodyFor(value: unknown): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value);
}

export async function setupSandbox(input: SandboxSetupInput): Promise<SandboxSetupResult> {
  const steps: string[] = [];
  const cookieName = input.sessionCookieName ?? "agents_session";
  const orgBase = `/api/organizations/${encodeURIComponent(input.organizationId)}`;

  async function product(
    session: string,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    step = "product request",
  ): Promise<Json> {
    const response = await fetch(`${input.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        origin: input.origin,
        cookie: `${cookieName}=${session}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: bodyFor(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let value: Json = {};
    try { value = text ? JSON.parse(text) as Json : {}; } catch { value = {}; }
    if (!response.ok) {
      const error = value.error && typeof value.error === "object" ? value.error as Json : {};
      throw new SandboxSetupError(
        step,
        response.status,
        typeof error.code === "string" ? error.code : null,
        typeof error.message === "string" ? error.message : `HTTP ${response.status}`,
      );
    }
    return value;
  }

  // 1. Model connection and default.
  let modelConnection: Json | undefined;
  const connections = await product(input.ownerSession, "GET", `${orgBase}/model-providers`, undefined, "list model providers");
  const existingConnection = (connections.connections ?? []).find((item: Json) =>
    item.name === input.model.name && item.state === "active");
  if (existingConnection) {
    modelConnection = existingConnection;
    steps.push("model connection reused");
  } else {
    const created = await product(input.ownerSession, "POST", `${orgBase}/model-providers`, {
      providerId: input.model.providerId,
      name: input.model.name,
      apiKey: input.model.apiKey,
    }, "create model connection");
    modelConnection = created.connection;
    await product(
      input.ownerSession,
      "POST",
      `${orgBase}/model-providers/${encodeURIComponent(modelConnection!.id)}/models/refresh`,
      { expectedRevision: modelConnection!.revision },
      "refresh model catalogue",
    );
    steps.push("model connection created");
  }
  const modelConnectionId = String(modelConnection!.id);
  const currentDefault = await product(input.ownerSession, "GET", `${orgBase}/model-providers/default`, undefined, "read model default");
  if (
    currentDefault.selection?.connectionId !== modelConnectionId ||
    currentDefault.selection?.modelId !== input.model.modelId
  ) {
    await product(input.ownerSession, "PUT", `${orgBase}/model-providers/default`, {
      connectionId: modelConnectionId,
      modelId: input.model.modelId,
      expectedRevision: currentDefault.revision,
    }, "set model default");
    steps.push("model default set");
  }

  // 2. Knowledge import and approval.
  let sourceId: string;
  let sourceRevisionId: string;
  let knowledgeJobId: string;
  const existingSources = await product(input.ownerSession, "GET", `${orgBase}/knowledge/sources`, undefined, "list knowledge sources");
  const existingSource = (existingSources.sources ?? []).find((item: Json) =>
    item.title === input.knowledge.title && item.state === "active");
  const approvedRevision = existingSource?.revisions?.find((item: Json) => item.state === "approved");
  if (existingSource && approvedRevision) {
    sourceId = String(existingSource.id);
    sourceRevisionId = String(approvedRevision.id);
    knowledgeJobId = String(approvedRevision.id);
    if (input.knowledge.visibility === "public" && existingSource.visibility !== "public") {
      await product(input.ownerSession, "POST", `${orgBase}/knowledge/sources/${encodeURIComponent(sourceId)}/policy`, {
        operationId: randomUUID(),
        expectedGeneration: existingSource.generation,
        action: "visibility",
        visibility: "public",
      }, "publish knowledge visibility");
      steps.push("knowledge visibility published");
    }
    steps.push("knowledge source reused");
  } else {
    const imported = await product(input.ownerSession, "POST", `${orgBase}/knowledge/imports`, {
      kind: "upload",
      operationId: randomUUID(),
      title: input.knowledge.title,
      contentType: "text/plain",
      contentBase64: Buffer.from(input.knowledge.content, "utf8").toString("base64"),
    }, "import knowledge");
    let job = imported.job as Json;
    knowledgeJobId = String(job.id);
    const deadline = Date.now() + 30_000;
    while (!["ready", "failed", "cancelled"].includes(job.state)) {
      if (Date.now() >= deadline) {
        throw new SandboxSetupError("wait for knowledge", null, null, "Knowledge import did not become ready");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      job = (await product(input.ownerSession, "GET", `${orgBase}/knowledge/imports/${encodeURIComponent(knowledgeJobId)}`, undefined, "read knowledge import")).job as Json;
    }
    if (job.state !== "ready") {
      throw new SandboxSetupError("import knowledge", null, String(job.errorCode ?? "INGESTION_FAILED"), "Knowledge import failed");
    }
    sourceId = String(job.sourceId);
    sourceRevisionId = String(job.revisionId);
    await product(input.ownerSession, "POST", `${orgBase}/knowledge/sources/${encodeURIComponent(sourceId)}/policy`, {
      operationId: randomUUID(),
      expectedGeneration: job.acceptedGeneration,
      action: "approve",
      revisionId: sourceRevisionId,
    }, "approve knowledge revision");
    if (input.knowledge.visibility === "public") {
      await product(input.ownerSession, "POST", `${orgBase}/knowledge/sources/${encodeURIComponent(sourceId)}/policy`, {
        operationId: randomUUID(),
        expectedGeneration: job.acceptedGeneration,
        action: "visibility",
        visibility: "public",
      }, "publish knowledge visibility");
    }
    steps.push("knowledge imported and approved");
  }

  // 3. Agent and immutable version.
  let agentId: string;
  let versionId: string;
  let compositionDigest: string;
  const existingAgents = await product(input.ownerSession, "GET", `${orgBase}/agents`, undefined, "list agents");
  const existingAgent = (existingAgents.agents ?? []).find((item: Json) => item.name === input.agent.name);
  if (existingAgent) {
    agentId = String(existingAgent.id);
    const detail = await product(input.ownerSession, "GET", `${orgBase}/agents/${encodeURIComponent(agentId)}`, undefined, "read existing agent");
    const versions = detail.versions ?? [];
    if (!versions.length) {
      throw new SandboxSetupError("read existing agent", null, "CONFIGURATION_UNAVAILABLE", "Existing agent has no published version");
    }
    const latest = [...versions].sort((left: Json, right: Json) =>
      Number(right.number ?? 0) - Number(left.number ?? 0))[0]!;
    versionId = String(latest.id);
    compositionDigest = String(latest.effectiveComposition?.digest ?? latest.effective_composition?.digest);
    steps.push("agent and version reused");
  } else {
    const configuration = structuredClone(input.agent.configuration) as Json;
    configuration.instructions = input.agent.instructions;
    configuration.sourceRevisionIds = [sourceRevisionId];
    const created = await product(input.ownerSession, "POST", `${orgBase}/agents`, {
      name: input.agent.name,
      configuration,
    }, "create agent");
    agentId = String(created.agent.id);
    let createdAgent = created.agent;
    if (input.agent.responsibilities?.length) {
      const updated = await product(input.ownerSession, "PUT", `${orgBase}/agents/${encodeURIComponent(agentId)}/capabilities`, {
        responsibilities: input.agent.responsibilities,
        expectedRevision: createdAgent.draftRevision,
        confirmImpact: true,
      }, "save agent capabilities");
      createdAgent = updated.agent;
      steps.push("agent capabilities saved");
    }
    const published = await product(input.ownerSession, "POST", `${orgBase}/agents/${encodeURIComponent(agentId)}/versions`, {
      expectedRevision: createdAgent.draftRevision,
    }, "publish agent version");
    versionId = String(published.version.id);
    compositionDigest = String(published.version.effectiveComposition?.digest ?? published.version.effective_composition?.digest);
    steps.push("agent created and version published");
  }
  if (!/^[a-f0-9]{64}$/.test(compositionDigest)) {
    throw new SandboxSetupError("read composition", null, null, "Published version has no composition digest");
  }

  const preview = await product(input.ownerSession, "POST", `${orgBase}/agents/${encodeURIComponent(agentId)}/model-preview`, {
    versionId,
    rootTokenLimit: input.agent.rootTokenLimit ?? 16_384,
  }, "read model route preview");
  const modelRoutesDigest = String(preview.modelRoutesDigest);
  if (!/^[a-f0-9]{64}$/.test(modelRoutesDigest)) {
    throw new SandboxSetupError("read model route preview", null, null, "Model preview has no route digest");
  }

  // 4. Second member through the normal member API, then verify member restrictions.
  let memberAccountId = "";
  const members = await product(input.ownerSession, "GET", `${orgBase}/members`, undefined, "list members");
  const existingMember = (members.members ?? []).find((item: Json) => item.email === input.member.email);
  if (existingMember) {
    memberAccountId = String(existingMember.accountId);
    steps.push("member reused");
  } else {
    const added = await product(input.ownerSession, "POST", `${orgBase}/members`, {
      email: input.member.email,
      role: "member",
    }, "add member");
    memberAccountId = String(added.member.accountId);
    steps.push("member added");
  }
  const memberView = await product(input.member.session, "GET", `${orgBase}/members`, undefined, "member list");
  if (memberView.canManage !== false) {
    throw new SandboxSetupError("member restrictions", null, null, "Member unexpectedly received owner management access");
  }
  try {
    await product(input.member.session, "POST", `${orgBase}/invitations`, {
      email: `blocked-${randomUUID()}@example.test`,
      role: "member",
    }, "member invitation");
    throw new SandboxSetupError("member restrictions", null, null, "Member unexpectedly created an invitation");
  } catch (error) {
    if (!(error instanceof SandboxSetupError) || error.status !== 403) throw error;
  }

  // 5. Read back through normal APIs.
  const readBack = await product(input.ownerSession, "GET", `${orgBase}/agents/${encodeURIComponent(agentId)}`, undefined, "read agent");
  if (!(readBack.versions ?? []).some((item: Json) => item.id === versionId)) {
    throw new SandboxSetupError("read back agent", null, null, "Published version is missing from the agent read");
  }
  if (input.agent.responsibilities?.includes("enquiries")) {
    const readiness = await product(input.ownerSession, "GET", `${orgBase}/agents/${encodeURIComponent(agentId)}/setup-readiness`, undefined, "read setup readiness");
    if (readiness.readiness?.requirements?.enquiries?.state !== "ready") {
      throw new SandboxSetupError("read setup readiness", null, "ENQUIRY_CAPABILITY_NOT_READY", "Enquiry capability is not ready");
    }
    steps.push("enquiry readiness verified");
  }
  let deploymentId: string | null = null;
  if (input.website) {
    const existing = (readBack.deployments ?? []).find((item: Json) =>
      item.versionId === versionId &&
      !item.revokedAt &&
      input.website!.allowedOrigins.every((origin) => (item.allowedOrigins ?? []).includes(origin)));
    if (existing) {
      deploymentId = String(existing.id);
      steps.push("website deployment reused");
    } else {
      const deployed = await product(input.ownerSession, "POST", `${orgBase}/agents/${encodeURIComponent(agentId)}/deployments`, {
        versionId,
        allowedOrigins: input.website.allowedOrigins,
      }, "publish website deployment");
      deploymentId = String(deployed.deployment.id);
      steps.push("website deployment published");
    }
  }
  const readSources = await product(input.ownerSession, "GET", `${orgBase}/knowledge/sources`, undefined, "read knowledge");
  if (!(readSources.sources ?? []).some((item: Json) =>
    item.id === sourceId && item.revisions?.some((revision: Json) => revision.id === sourceRevisionId && revision.state === "approved"))) {
    throw new SandboxSetupError("read back knowledge", null, null, "Approved knowledge revision is missing");
  }
  steps.push("normal API read-back passed");

  // 6. Record the product refs in the evaluation control plane.
  let agentRefId: string | null = null;
  if (input.controlPlane) {
    const control = input.controlPlane;
    const record = async () => {
      const response = await fetch(`${control.apiUrl.replace(/\/+$/, "")}/v1/sandboxes/${encodeURIComponent(control.sandboxId)}/agents`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${control.operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspaceRefId: control.workspaceRefId,
          productAgentId: agentId,
          productVersionId: versionId,
          sourceIds: [sourceId],
          compositionDigest,
          modelRoutesDigest,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const value = await response.json().catch(() => ({})) as Json;
      if (response.status === 409 && value.code === "AGENT_REF_EXISTS") {
        const listed = await fetch(`${control.apiUrl.replace(/\/+$/, "")}/v1/sandboxes/${encodeURIComponent(control.sandboxId)}/agents`, {
          headers: { authorization: `Bearer ${control.operatorToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        const data = await listed.json().catch(() => ({})) as Json;
        const found = (data.agentRefs ?? []).find((item: Json) =>
          item.productAgentId === agentId && item.productVersionId === versionId);
        if (found) return String(found.id);
      }
      if (!response.ok) {
        throw new SandboxSetupError("record control-plane agent", response.status, typeof value.code === "string" ? value.code : null, "Control-plane agent reference was not recorded");
      }
      return String(value.agentRef.id);
    };
    agentRefId = await record();
    steps.push("control-plane agent reference recorded");
  }

  return {
    modelConnectionId,
    modelId: input.model.modelId,
    knowledgeJobId,
    sourceId,
    sourceRevisionId,
    agentId,
    versionId,
    compositionDigest,
    modelRoutesDigest,
    memberAccountId,
    deploymentId,
    agentRefId,
    steps,
  };
}
