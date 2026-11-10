import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import { getAgentRef, getSandbox } from "./store.js";
import { ownerRequest, readOwnerSession } from "./product-agents.js";

export interface AgentModelOption {
  connectionId: string;
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

export async function listAgentModels(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  agentRefId: string,
): Promise<AgentModelCatalogue> {
  const { session, featureId } = await growthContext(config, pool, sandboxId, agentRefId);
  const value = await ownerRequest(
    session,
    "kasitek_session",
    "GET",
    `/api/agents/features/${encodeURIComponent(featureId)}/models`,
  );
  return value as unknown as AgentModelCatalogue;
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
