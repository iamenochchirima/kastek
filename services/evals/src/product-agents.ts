import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import {
  createAgentRef,
  getSandbox,
  listAgentRefs,
  type AgentRef,
  type SandboxDetail,
} from "./store.js";

export interface OwnerSession {
  origin: string;
  organizationId: string;
  organizationName?: string;
  session: string;
  sessionCookieName?: string;
}

export class ProductAgentError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProductAgentError";
  }
}

export interface ProductAgent {
  refId: string;
  product: "agents" | "growth";
  productAgentId: string;
  productVersionId: string;
  workspaceRefId: string;
  name: string;
  description: string | null;
  avatar: string | null;
  ready: boolean;
  revision: string | null;
  model: { label: string; provider?: string; modelId?: string } | null;
  specialists: Array<{ id: string; name: string; state: string }>;
  source: "growth-feature" | "agents-agent";
}

type Json = Record<string, any>;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function ownerSessionPath(config: EvalsConfig, detail: SandboxDetail): string {
  const runtimePath = detail.sandbox.runtime.sessionFile;
  if (typeof runtimePath === "string" && runtimePath) return runtimePath;
  return join(config.repoRoot, ".audit", "sandboxes", detail.sandbox.id, "owner-session.json");
}

export async function readOwnerSession(
  config: EvalsConfig,
  detail: SandboxDetail,
): Promise<OwnerSession> {
  const raw = await readFile(ownerSessionPath(config, detail), "utf8");
  const value = JSON.parse(raw) as OwnerSession;
  if (!value.origin || !value.organizationId || !value.session) {
    throw new Error("Sandbox owner session is incomplete");
  }
  return value;
}

export async function ownerRequest(
  session: OwnerSession,
  cookieName: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<Json> {
  const response = await fetch(`${session.origin.replace(/\/+$/, "")}${path}`, {
    method,
    headers: {
      origin: session.origin,
      cookie: `${cookieName}=${session.session}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let value: Json = {};
  try {
    value = text ? JSON.parse(text) as Json : {};
  } catch {
    value = {};
  }
  if (!response.ok) {
    const error = value.error && typeof value.error === "object" ? value.error as Json : {};
    throw new Error(
      typeof error.message === "string"
        ? error.message
        : typeof value.error === "string"
          ? value.error
          : `Product request failed with HTTP ${response.status}`,
    );
  }
  return value;
}

async function ensureRef(
  pool: Pool,
  sandboxId: string,
  workspaceRefId: string,
  input: {
    productAgentId: string;
    productVersionId: string;
    compositionDigest: string;
    modelRoutesDigest: string;
  },
): Promise<AgentRef> {
  const existing = (await listAgentRefs(pool, sandboxId)).find((item) =>
    item.productAgentId === input.productAgentId &&
    item.productVersionId === input.productVersionId);
  if (existing) return existing;
  try {
    return await createAgentRef(pool, sandboxId, {
      workspaceRefId,
      productAgentId: input.productAgentId,
      productVersionId: input.productVersionId,
      sourceIds: [],
      compositionDigest: input.compositionDigest,
      modelRoutesDigest: input.modelRoutesDigest,
    });
  } catch (error) {
    if ((error as { code?: string }).code !== "AGENT_REF_EXISTS") throw error;
    const ref = (await listAgentRefs(pool, sandboxId)).find((item) =>
      item.productAgentId === input.productAgentId &&
      item.productVersionId === input.productVersionId);
    if (!ref) throw error;
    return ref;
  }
}

function growthAgent(
  detail: SandboxDetail,
  workspaceRefId: string,
  feature: Json,
  ref: AgentRef,
): ProductAgent {
  return {
    refId: ref.id,
    product: "growth",
    productAgentId: feature.id,
    productVersionId: `growth-revision-${feature.revision ?? 0}`,
    workspaceRefId,
    name: String(feature.name ?? feature.id),
    description: typeof feature.description === "string" ? feature.description : null,
    avatar: typeof feature.avatar === "string" ? feature.avatar : null,
    ready: feature.ready === true,
    revision: feature.revision == null ? null : String(feature.revision),
    model: feature.model && typeof feature.model === "object"
      ? {
          label: String(feature.model.label ?? feature.model.modelId ?? "Model"),
          ...(typeof feature.model.provider === "string" ? { provider: feature.model.provider } : {}),
          ...(typeof feature.model.modelId === "string" ? { modelId: feature.model.modelId } : {}),
        }
      : null,
    specialists: Array.isArray(feature.specialists)
      ? feature.specialists.map((item: Json) => ({
          id: String(item.id),
          name: String(item.name ?? item.id),
          state: String(item.state ?? "configured"),
        }))
      : [],
    source: "growth-feature",
  };
}

async function growthAgents(
  config: EvalsConfig,
  pool: Pool,
  detail: SandboxDetail,
): Promise<ProductAgent[]> {
  const session = await readOwnerSession(config, detail);
  const workspace = detail.workspaceRefs.find((item) =>
    item.productWorkspaceId === session.organizationId) ?? detail.workspaceRefs[0];
  if (!workspace) throw new Error("Sandbox has no Growth workspace reference");
  const bootstrap = await ownerRequest(session, "kasitek_session", "GET", "/api/agents/bootstrap");
  const features = Array.isArray(bootstrap.features) ? bootstrap.features as Json[] : [];
  if (features.length > 0 && features.every((feature) => feature.ready !== true)) {
    throw new ProductAgentError(
      503,
      "agent_runtime_unavailable",
      "Growth Agents runtime is unavailable. Restart the sandbox runtime and retry.",
    );
  }
  const agents: ProductAgent[] = [];
  for (const feature of features) {
    if (typeof feature.id !== "string" || feature.ready !== true) continue;
    const revision = feature.revision == null ? 0 : Number(feature.revision);
    const descriptor = {
      kind: "growth-feature",
      id: feature.id,
      revision,
      name: feature.name,
      description: feature.description,
      avatar: feature.avatar,
      model: feature.model ?? null,
      specialists: feature.specialists ?? [],
      memory: feature.memory ?? null,
    };
    const ref = await ensureRef(pool, detail.sandbox.id, workspace.id, {
      productAgentId: feature.id,
      productVersionId: `growth-revision-${revision}`,
      compositionDigest: digest(descriptor),
      modelRoutesDigest: digest(feature.model ?? {}),
    });
    agents.push(growthAgent(detail, workspace.id, feature, ref));
  }
  return agents;
}

async function agentsAgents(
  config: EvalsConfig,
  pool: Pool,
  detail: SandboxDetail,
): Promise<ProductAgent[]> {
  const session = await readOwnerSession(config, detail);
  const workspace = detail.workspaceRefs.find((item) =>
    item.productWorkspaceId === session.organizationId) ?? detail.workspaceRefs[0];
  if (!workspace) throw new Error("Sandbox has no Agents workspace reference");
  const orgBase = `/api/organizations/${encodeURIComponent(session.organizationId)}`;
  const listed = await ownerRequest(session, "agents_session", "GET", `${orgBase}/agents`);
  const agents = Array.isArray(listed.agents) ? listed.agents as Json[] : [];
  const result: ProductAgent[] = [];
  for (const agent of agents) {
    if (typeof agent.id !== "string") continue;
    const detailValue = await ownerRequest(session, "agents_session", "GET", `${orgBase}/agents/${encodeURIComponent(agent.id)}`);
    const versions = Array.isArray(detailValue.versions) ? detailValue.versions as Json[] : [];
    const latest = versions.sort((left, right) =>
      Number(right.number ?? 0) - Number(left.number ?? 0))[0];
    const draftRevision = Number(agent.draftRevision ?? 0);
    const productVersionId = latest?.id ? String(latest.id) : `draft-${draftRevision}`;
    const compositionDigest = typeof latest?.effectiveComposition?.digest === "string"
      ? latest.effectiveComposition.digest
      : digest(agent.draft ?? {});
    const modelRoutesDigest = digest(agent.draft?.model ?? latest?.model ?? {});
    const ref = await ensureRef(pool, detail.sandbox.id, workspace.id, {
      productAgentId: agent.id,
      productVersionId,
      compositionDigest,
      modelRoutesDigest,
    });
    result.push({
      refId: ref.id,
      product: "agents",
      productAgentId: agent.id,
      productVersionId,
      workspaceRefId: workspace.id,
      name: String(agent.name ?? "Agent"),
      description: typeof agent.description === "string" ? agent.description : null,
      avatar: typeof agent.avatar === "string" ? agent.avatar : null,
      ready: Boolean(latest),
      revision: latest?.number == null ? String(draftRevision) : String(latest.number),
      model: null,
      specialists: [],
      source: "agents-agent",
    });
  }
  return result;
}

export async function listProductAgents(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
): Promise<ProductAgent[]> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) throw new Error("Sandbox not found");
  if (detail.sandbox.status === "provisioning") {
    throw new Error("Sandbox is still provisioning");
  }
  if (detail.sandbox.product === "growth") return growthAgents(config, pool, detail);
  if (detail.sandbox.product === "agents") return agentsAgents(config, pool, detail);
  throw new Error(`Unsupported sandbox product: ${detail.sandbox.product}`);
}
