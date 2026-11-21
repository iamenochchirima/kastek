import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import { getAgentRef, getSandbox } from "./store.js";
import { ownerRequest, readOwnerSession } from "./product-agents.js";

export interface AgentModelOption {
  connectionId: string;
  connectionLabel: string;
  modelId: string;
  label: string;
  provider: string;
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
  pricing: {
    currency: "USD";
    inputMicrosPerMillionTokens: number | null;
    outputMicrosPerMillionTokens: number | null;
  } | null;
}

export interface AgentModelCatalogue {
  current: { connectionId: string; modelId: string } | null;
  defaultModel: AgentModelOption | null;
  inherited: boolean;
  revision: number;
  models: AgentModelOption[];
}

export class ProductModelError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductModelError";
  }
}

function fail(statusCode: number, code: string, message: string): never {
  throw new ProductModelError(statusCode, code, message);
}

type Json = Record<string, any>;

async function growthContext(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRefId: string,
) {
  const sandbox = await getSandbox(pool, sandboxId);
  if (!sandbox) fail(404, "not_found", "Sandbox not found");
  if (sandbox.sandbox.product !== "growth") {
    fail(400, "model_selection_unsupported", "Model selection is only available for Growth sandboxes");
  }
  const agentRef = await getAgentRef(pool, sandboxId, agentRefId);
  if (!agentRef) fail(404, "agent_not_found", "Agent reference not found");
  const session = await readOwnerSession(config, sandbox);
  return { sandbox, agentRef, session, featureId: agentRef.productAgentId };
}

async function agentsContext(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRefId: string,
) {
  const sandbox = await getSandbox(pool, sandboxId);
  if (!sandbox) fail(404, "not_found", "Sandbox not found");
  if (sandbox.sandbox.product !== "agents") {
    fail(400, "model_selection_unsupported", "Model selection is not available for this sandbox");
  }
  const agentRef = await getAgentRef(pool, sandboxId, agentRefId);
  if (!agentRef) fail(404, "agent_not_found", "Agent reference not found");
  const session = await readOwnerSession(config, sandbox);
  return { sandbox, agentRef, session, agentId: agentRef.productAgentId };
}

function agentModelOption(connection: Json, model: Json): AgentModelOption {
  return {
    connectionId: String(connection.id),
    connectionLabel: String(connection.name || connection.providerId),
    modelId: String(model.id),
    label: String(model.name || model.id),
    provider: String(connection.providerId),
    contextWindowTokens: typeof model.contextTokens?.value === "number" ? model.contextTokens.value : null,
    maxOutputTokens: typeof model.maxOutputTokens?.value === "number" ? model.maxOutputTokens.value : null,
    pricing: model.pricing ? {
      currency: "USD",
      inputMicrosPerMillionTokens: typeof model.pricing.inputMicrosPerMillionTokens === "number" ? model.pricing.inputMicrosPerMillionTokens : null,
      outputMicrosPerMillionTokens: typeof model.pricing.outputMicrosPerMillionTokens === "number" ? model.pricing.outputMicrosPerMillionTokens : null,
    } : null,
  };
}

async function agentsCatalogue(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRefId: string,
): Promise<AgentModelCatalogue> {
  const { session, agentId } = await agentsContext(config, pool, sandboxId, agentRefId);
  const orgBase = `/api/organizations/${encodeURIComponent(session.organizationId)}`;
  const [detail, providers, defaultSelection] = await Promise.all([
    ownerRequest(session, "agents_session", "GET", `${orgBase}/agents/${encodeURIComponent(agentId)}`),
    ownerRequest(session, "agents_session", "GET", `${orgBase}/model-providers`),
    ownerRequest(session, "agents_session", "GET", `${orgBase}/model-providers/default`),
  ]);
  const connections = (Array.isArray(providers.connections) ? providers.connections as Json[] : [])
    .filter((connection) => connection.state === "active");
  const models: AgentModelOption[] = [];
  for (const connection of connections) {
    const cached = await ownerRequest(
      session,
      "agents_session",
      "GET",
      `${orgBase}/model-providers/${encodeURIComponent(String(connection.id))}/models`,
    ).catch(() => null);
    const result = (cached as Json | null)?.result;
    if (!result || result.kind !== "discovered") continue;
    for (const model of Array.isArray(result.models) ? result.models as Json[] : []) {
      if (model?.lifecycle === "retired" || typeof model?.id !== "string") continue;
      models.push(agentModelOption(connection, model));
    }
  }
  const selection = (detail.agent as Json | undefined)?.draft?.model?.selection;
  const find = (connectionId: string, modelId: string) =>
    models.find((model) => model.connectionId === connectionId && model.modelId === modelId) ?? null;
  const current = selection?.kind === "connection"
    ? find(String(selection.connectionId), String(selection.modelId))
    : null;
  const defaultSelectionValue = (defaultSelection as Json).selection;
  const defaultModel = defaultSelectionValue?.kind === "connection"
    ? find(String(defaultSelectionValue.connectionId), String(defaultSelectionValue.modelId))
    : null;
  return {
    current: current ? { connectionId: current.connectionId, modelId: current.modelId } : null,
    defaultModel,
    inherited: !selection || selection.kind === "organization_default",
    revision: Number((defaultSelection as Json).revision ?? 0),
    models,
  };
}

export async function listAgentModels(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRefId: string,
): Promise<AgentModelCatalogue> {
  const sandbox = await getSandbox(pool, sandboxId);
  if (!sandbox) fail(404, "not_found", "Sandbox not found");
  if (sandbox.sandbox.product === "agents") {
    return agentsCatalogue(config, pool, sandboxId, agentRefId);
  }
  if (sandbox.sandbox.product === "growth") {
    const { session, featureId } = await growthContext(config, pool, sandboxId, agentRefId);
    const value = await ownerRequest(
      session,
      "kasitek_session",
      "GET",
      `/api/agents/features/${encodeURIComponent(featureId)}/models`,
    );
    return value as unknown as AgentModelCatalogue;
  }
  fail(400, "model_selection_unsupported", `Model selection is not available for ${sandbox.sandbox.product} sandboxes`);
}

export async function selectAgentModel(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRefId: string,
  selection:
    | { kind: "organization_default" }
    | { kind: "connection"; connectionId: string; modelId: string },
): Promise<{ revision: number }> {
  const sandbox = await getSandbox(pool, sandboxId);
  if (!sandbox) fail(404, "not_found", "Sandbox not found");
  if (sandbox.sandbox.product === "agents") {
    const { session } = await agentsContext(config, pool, sandboxId, agentRefId);
    const orgBase = `/api/organizations/${encodeURIComponent(session.organizationId)}`;
    const current = await ownerRequest(
      session,
      "agents_session",
      "GET",
      `${orgBase}/model-providers/default`,
    );
    if (selection.kind === "organization_default") {
      return { revision: Number((current as Json).revision ?? 0) };
    }
    const saved = await ownerRequest(
      session,
      "agents_session",
      "PUT",
      `${orgBase}/model-providers/default`,
      {
        connectionId: selection.connectionId,
        modelId: selection.modelId,
        expectedRevision: Number((current as Json).revision ?? 0),
      },
    );
    return { revision: Number((saved as Json).revision ?? 0) };
  }
  if (sandbox.sandbox.product === "growth") {
    const { session, featureId } = await growthContext(config, pool, sandboxId, agentRefId);
    const catalogue = await listAgentModels(config, pool, sandboxId, agentRefId);
    const value = await ownerRequest(
      session,
      "kasitek_session",
      "PATCH",
      `/api/agents/features/${encodeURIComponent(featureId)}/model`,
      {
        requestId: randomUUID(),
        expectedRevision: catalogue.revision,
        selection,
      },
    );
    return value as unknown as { revision: number };
  }
  fail(400, "model_selection_unsupported", `Model selection is not available for ${sandbox.sandbox.product} sandboxes`);
}
