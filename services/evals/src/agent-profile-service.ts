import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import { setupSandbox, SandboxSetupError } from "./harness/setup.js";
import { getSandbox, type SandboxDetail, type WorkspaceRef } from "./store.js";
import {
  createAgentProfile,
  createAgentProfileVersion,
  createAgentSetupRun,
  getAgentProfile,
  latestReadySetupRunForProfile,
  listAgentProfiles,
  updateAgentSetupRun,
  type AgentProfileDetail,
  type AgentProfileSpec,
  type AgentSetupRun,
  type AgentSetupStep,
  type AgentTargetType,
} from "./profile-store.js";
import { ownerRequest, readOwnerSession, type OwnerSession } from "./product-agents.js";

export class AgentProfileError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentProfileError";
  }
}

function fail(statusCode: number, code: string, message: string): never {
  throw new AgentProfileError(statusCode, code, message);
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") fail(400, "invalid_field", `${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) fail(400, "invalid_field", `${name} must be between 1 and ${max} characters`);
  return normalized;
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value == null) return undefined;
  return text(value, name, max);
}

const responsibilities = new Set(["answer-questions", "customer-support", "bookings", "enquiries"]);

export function parseAgentProfileSpec(raw: unknown): AgentProfileSpec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(400, "invalid_profile", "Profile specification must be an object");
  }
  const input = raw as Record<string, unknown>;
  const targetType = text(input.targetType, "targetType", 32) as AgentTargetType;
  if (!["platform_assistant", "business_agent"].includes(targetType)) {
    fail(400, "invalid_profile", "targetType must be platform_assistant or business_agent");
  }
  const agentName = text(input.agentName, "agentName", 120);
  const avatar = optionalText(input.avatar, "avatar", 32);
  const offering = optionalText(input.offering, "offering", 32);
  if (offering && offering !== "customer-service") {
    fail(400, "invalid_profile", "offering must be customer-service when provided");
  }
  if (offering && targetType === "platform_assistant") {
    fail(400, "invalid_profile", "The platform Assistant does not use an offering");
  }
  const configuration = input.configuration == null
    ? undefined
    : typeof input.configuration === "object" && !Array.isArray(input.configuration)
      ? input.configuration as Record<string, unknown>
      : fail(400, "invalid_profile", "configuration must be an object");
  const setup = input.setup == null
    ? undefined
    : typeof input.setup === "object" && !Array.isArray(input.setup)
      ? input.setup as Record<string, unknown>
      : fail(400, "invalid_profile", "setup must be an object");
  if (configuration && JSON.stringify(configuration).length > 200_000) {
    fail(400, "invalid_profile", "configuration is too large");
  }
  if (setup && JSON.stringify(setup).length > 20_000) {
    fail(400, "invalid_profile", "setup is too large");
  }
  const instructions = text(input.instructions, "instructions", 32_000);
  const knowledge = input.knowledge;
  if (!knowledge || typeof knowledge !== "object" || Array.isArray(knowledge)) {
    fail(400, "invalid_profile", "knowledge is required");
  }
  const knowledgeInput = knowledge as Record<string, unknown>;
  const title = text(knowledgeInput.title, "knowledge.title", 200);
  const content = text(knowledgeInput.content, "knowledge.content", 1_000_000);
  const visibility = knowledgeInput.visibility === "public" ? "public" : "private";
  const responsibilityValues = input.responsibilities == null
    ? []
    : Array.isArray(input.responsibilities)
      ? input.responsibilities
      : fail(400, "invalid_profile", "responsibilities must be an array");
  const parsedResponsibilities = responsibilityValues.map((value) => {
    if (typeof value !== "string" || !responsibilities.has(value)) {
      fail(400, "invalid_profile", `Unknown responsibility: ${String(value)}`);
    }
    return value as AgentProfileSpec["responsibilities"][number];
  });
  let model: AgentProfileSpec["model"] | undefined;
  if (input.model != null) {
    if (typeof input.model !== "object" || Array.isArray(input.model)) {
      fail(400, "invalid_profile", "model must be an object");
    }
    const modelInput = input.model as Record<string, unknown>;
    model = {
      providerId: text(modelInput.providerId, "model.providerId", 64),
      connectionName: text(modelInput.connectionName, "model.connectionName", 120),
      modelId: text(modelInput.modelId, "model.modelId", 256),
    };
  }
  let website: AgentProfileSpec["website"];
  if (input.website != null) {
    if (typeof input.website !== "object" || Array.isArray(input.website)) {
      fail(400, "invalid_profile", "website must be an object");
    }
    const websiteInput = input.website as Record<string, unknown>;
    if (!Array.isArray(websiteInput.allowedOrigins) || websiteInput.allowedOrigins.length === 0) {
      fail(400, "invalid_profile", "website.allowedOrigins must be a non-empty array");
    }
    website = {
      allowedOrigins: websiteInput.allowedOrigins.map((value) => {
        const origin = text(value, "website.allowedOrigins", 320);
        try {
          const url = new URL(origin);
          if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash) {
            throw new Error("origin");
          }
          return url.origin;
        } catch {
          fail(400, "invalid_profile", `Invalid website origin: ${origin}`);
        }
      }),
    };
  }
  return {
    targetType,
    agentName,
    ...(offering ? { offering: offering as "customer-service" } : {}),
    ...(avatar ? { avatar } : {}),
    ...(model ? { model } : {}),
    ...(configuration ? { configuration } : {}),
    ...(setup ? { setup } : {}),
    instructions,
    knowledge: { title, content, visibility },
    responsibilities: [...new Set(parsedResponsibilities)],
    ...(website ? { website } : {}),
  };
}

function workspaceFor(sandbox: SandboxDetail, organizationId: string): WorkspaceRef {
  const workspace = sandbox.workspaceRefs.find((item) => item.productWorkspaceId === organizationId)
    ?? sandbox.workspaceRefs[0];
  if (!workspace) fail(409, "workspace_missing", "Sandbox has no workspace reference");
  return workspace;
}

async function productAgent(
  session: OwnerSession,
  organizationId: string,
  agentId: string,
): Promise<Record<string, any>> {
  return ownerRequest(
    session,
    "agents_session",
    "GET",
    `/api/organizations/${encodeURIComponent(organizationId)}/agents/${encodeURIComponent(agentId)}`,
  );
}

async function assistantAgent(
  session: OwnerSession,
  organizationId: string,
): Promise<Record<string, any>> {
  const assistant = await ownerRequest(
    session,
    "agents_session",
    "GET",
    `/api/organizations/${encodeURIComponent(organizationId)}/assistant`,
  );
  const agent = assistant.agent as Record<string, any> | undefined;
  if (!agent?.id) fail(409, "assistant_unavailable", "The platform Assistant is unavailable");
  return agent;
}

function stepList(names: string[]): AgentSetupStep[] {
  return names.map((name) => ({ name, status: "pending" as const }));
}

function step(steps: AgentSetupStep[], name: string, status: AgentSetupStep["status"], message?: string): AgentSetupStep[] {
  const next = steps.filter((item) => item.name !== name);
  next.push({ name, status, ...(message ? { message } : {}), at: new Date().toISOString() });
  return next;
}

function failedStep(error: unknown): string {
  if (error instanceof SandboxSetupError) {
    if (error.step.includes("knowledge")) return "knowledge";
    if (error.step.includes("model")) return "model";
    if (error.step.includes("agent") || error.step.includes("composition")) return "agent";
    if (error.step.includes("record control-plane")) return "register";
    return "apply";
  }
  return "apply";
}

async function resolveModel(
  pool: Pool,
  config: EvalsConfig,
  sandboxId: string,
  spec: AgentProfileSpec,
): Promise<AgentProfileSpec["model"]> {
  if (spec.model) return spec.model;
  const sandbox = await getSandbox(pool, sandboxId);
  if (!sandbox) fail(404, "not_found", "Sandbox not found");
  const session = await readOwnerSession(config, sandbox);
  const providers = await ownerRequest(
    session,
    "agents_session",
    "GET",
    `/api/organizations/${encodeURIComponent(session.organizationId)}/model-providers`,
  );
  const connection = (providers.connections ?? []).find((item: Record<string, any>) => item.state === "active");
  if (connection) {
    const defaultValue = await ownerRequest(
      session,
      "agents_session",
      "GET",
      `/api/organizations/${encodeURIComponent(session.organizationId)}/model-providers/default`,
    ).catch(() => ({}));
    const defaultSelection = (defaultValue as Record<string, any>).selection;
    const modelId = defaultSelection?.modelId ?? connection.defaultModel?.modelId;
    if (typeof modelId === "string") {
      return {
        providerId: String(connection.providerId ?? "openrouter"),
        connectionName: String(connection.name ?? "Evals model"),
        modelId,
      };
    }
  }
  fail(409, "model_required", "Choose a model connection and model for this agent");
}

export async function applyAgentProfile(
  config: EvalsConfig,
  pool: Pool,
  profileId: string,
  idempotencyKey: string,
): Promise<AgentSetupRun> {
  const profile = await getAgentProfile(pool, profileId);
  if (!profile) fail(404, "not_found", "Agent profile not found");
  const sandbox = await getSandbox(pool, profile.sandboxId);
  if (!sandbox) fail(404, "not_found", "Sandbox not found");
  if (sandbox.sandbox.status !== "ready") fail(409, "sandbox_not_ready", "Sandbox is not ready");
  const spec = profile.version.spec;
  const session = await readOwnerSession(config, sandbox);
  const workspace = workspaceFor(sandbox, session.organizationId);
  const run = await createAgentSetupRun(pool, {
    sandboxId: sandbox.sandbox.id,
    profileVersionId: profile.version.id,
    idempotencyKey,
  });
  if (run.status === "ready" || run.status === "failed" || run.status === "running") return run;
  const steps = stepList(["model", "knowledge", "agent", "register"]);
  await updateAgentSetupRun(pool, run.id, { status: "running", steps: step(steps, "model", "running") });
  try {
    const previousRun = await latestReadySetupRunForProfile(pool, profile.id);
    const previousAgentId = typeof previousRun?.result.agentId === "string"
      ? previousRun.result.agentId
      : undefined;
    const newBusinessAgent = spec.targetType === "business_agent" && !previousAgentId;
    const needsAssistantBase = spec.targetType === "platform_assistant" || (newBusinessAgent && !spec.offering);
    const assistant = needsAssistantBase
      ? await assistantAgent(session, session.organizationId)
      : null;
    const targetAgentId = spec.targetType === "platform_assistant"
      ? String(assistant!.id)
      : previousAgentId;
    const setupOverrides = (spec.setup ?? {}) as Record<string, any>;
    const setup = newBusinessAgent && spec.offering === "customer-service"
      ? {
          business: {
            name: spec.agentName,
            website: "",
            description: "",
            ...(setupOverrides.business ?? {}),
          },
          responsibilities: spec.responsibilities,
          channels: [],
          ...(setupOverrides.booking ? { booking: setupOverrides.booking } : {}),
          ...(setupOverrides.intake ? { intake: setupOverrides.intake } : {}),
          ...(setupOverrides.supportHours ? { supportHours: setupOverrides.supportHours } : {}),
          behaviour: {
            agentName: spec.agentName,
            language: "English",
            tone: "friendly",
            handoffInstructions: "",
            ...(setupOverrides.behaviour ?? {}),
          },
        }
      : undefined;
    const configuration = newBusinessAgent && !spec.offering
      ? {
          ...(assistant?.draft ?? {}),
          ...(spec.configuration ?? {}),
        }
      : spec.configuration ?? {};
    const model = await resolveModel(pool, config, sandbox.sandbox.id, spec);
    if (!model) fail(409, "model_required", "Choose a model for this agent");
    const apiKey = process.env.OPENROUTER_API_KEY?.trim() || "";
    const result = await setupSandbox({
      baseUrl: session.origin,
      origin: session.origin,
      organizationId: session.organizationId,
      ownerSession: session.session,
      sessionCookieName: "agents_session",
      model: {
        providerId: model.providerId,
        name: model.connectionName,
        apiKey,
        modelId: model.modelId,
      },
      knowledge: spec.knowledge,
      agent: {
        name: spec.agentName,
        configuration,
        instructions: spec.instructions,
        ...(targetAgentId ? { targetAgentId } : {}),
        ...(targetAgentId ? { updateExisting: true } : {}),
        ...(newBusinessAgent && spec.offering === "customer-service" ? { offering: "customer-service" as const } : {}),
        ...(newBusinessAgent ? { reuseExistingByName: false } : {}),
        ...(setup ? { setup } : {}),
        ...(spec.responsibilities.length ? { responsibilities: spec.responsibilities } : {}),
      },
      ...(spec.website ? { website: spec.website } : {}),
      controlPlane: {
        apiUrl: `http://${config.host}:${config.port}`,
        operatorToken: config.operatorToken,
        sandboxId: sandbox.sandbox.id,
        workspaceRefId: workspace.id,
      },
    });
    const finalSteps = stepList(["model", "knowledge", "agent", "register"])
      .map((item) => ({ ...item, status: "complete" as const, at: new Date().toISOString() }));
    return (await updateAgentSetupRun(pool, run.id, {
      status: "ready",
      steps: finalSteps,
      result: {
        ...result,
        workspaceRefId: workspace.id,
        profileVersion: profile.version.version,
        profileDigest: profile.version.specDigest,
      },
      error: null,
    }))!;
  } catch (error) {
    const name = failedStep(error);
    const message = error instanceof Error ? error.message : String(error);
    await updateAgentSetupRun(pool, run.id, {
      status: "failed",
      steps: step(steps, name, "failed", message),
      error: message.slice(0, 2_000),
    });
    throw error;
  }
}

export async function startAgentProfileSetup(
  config: EvalsConfig,
  pool: Pool,
  profileId: string,
  idempotencyKey: string,
): Promise<AgentSetupRun> {
  const profile = await getAgentProfile(pool, profileId);
  if (!profile) fail(404, "not_found", "Agent profile not found");
  const run = await createAgentSetupRun(pool, {
    sandboxId: profile.sandboxId,
    profileVersionId: profile.version.id,
    idempotencyKey,
  });
  if (run.status === "pending") {
    void applyAgentProfile(config, pool, profileId, idempotencyKey).catch(() => undefined);
  }
  return run;
}

export async function createProfile(
  pool: Pool,
  sandboxId: string,
  workspaceRefId: string,
  specInput: unknown,
): Promise<AgentProfileDetail> {
  const sandbox = await getSandbox(pool, sandboxId);
  if (!sandbox) fail(404, "not_found", "Sandbox not found");
  if (!sandbox.workspaceRefs.some((item) => item.id === workspaceRefId)) {
    fail(400, "workspace_mismatch", "Workspace does not belong to this sandbox");
  }
  const spec = parseAgentProfileSpec(specInput);
  return createAgentProfile(pool, {
    sandboxId,
    workspaceRefId,
    name: spec.agentName,
    targetType: spec.targetType,
    spec,
    specDigest: digest(spec),
  });
}

export async function createProfileVersion(
  pool: Pool,
  profileId: string,
  specInput: unknown,
): Promise<AgentProfileDetail> {
  const profile = await getAgentProfile(pool, profileId);
  if (!profile) fail(404, "not_found", "Agent profile not found");
  const spec = parseAgentProfileSpec(specInput);
  await createAgentProfileVersion(pool, profileId, spec, digest(spec));
  return (await getAgentProfile(pool, profileId))!;
}

export async function listProfiles(pool: Pool, sandboxId: string) {
  return listAgentProfiles(pool, sandboxId);
}

export async function getProfile(pool: Pool, profileId: string) {
  const profile = await getAgentProfile(pool, profileId);
  if (!profile) fail(404, "not_found", "Agent profile not found");
  return profile;
}
