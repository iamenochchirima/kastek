import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import {
  ApplicationApiError,
  ApplicationClient,
  normalizeApplicationUrl,
  type ApplicationAgentDetail,
  type ApplicationAgentSummary,
} from "./application-client.js";
import {
  createAgentRef,
  createApiEnvironment,
  getSandbox,
  listAgentRefs,
  listSandboxes,
  type AgentRef,
  type SandboxDetail,
  type WorkspaceRef,
} from "./store.js";
import { ownerRequest, ProductAgentError, readOwnerSession, type OwnerSession } from "./product-agents.js";

type Json = Record<string, any>;

export interface ApiAgent {
  id: string;
  name: string;
  draftRevision: number;
  version: { id: string; number: number; createdAt: string } | null;
  agentRefId: string | null;
}

export interface ApiAgentCreated {
  agent: ApiAgent;
  agentRef: AgentRef;
}

export class ApiEnvironmentError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiEnvironmentError";
  }
}

function fail(statusCode: number, code: string, message: string): never {
  throw new ApiEnvironmentError(statusCode, code, message);
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(400, "invalid_field", `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    fail(400, "invalid_field", `${name} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Json;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function credentialPath(config: EvalsConfig, environmentId: string): string {
  return join(config.repoRoot, ".audit", "api-environments", environmentId, "credential.json");
}

function environmentRuntime(detail: SandboxDetail): {
  baseUrl: string;
  organizationId: string;
  applicationId: string;
  credentialFile: string;
  name: string;
} {
  const runtime = detail.sandbox.runtime as Json;
  if (runtime.kind !== "api") {
    fail(409, "not_api_environment", "This environment is not connected through the application API");
  }
  for (const key of ["baseUrl", "organizationId", "applicationId", "credentialFile"] as const) {
    if (typeof runtime[key] !== "string" || !runtime[key]) {
      fail(409, "environment_incomplete", `The API environment is missing ${key}`);
    }
  }
  return {
    baseUrl: String(runtime.baseUrl),
    organizationId: String(runtime.organizationId),
    applicationId: String(runtime.applicationId),
    credentialFile: String(runtime.credentialFile),
    name: typeof runtime.name === "string" ? runtime.name : detail.sandbox.id,
  };
}

async function credential(endpoint: { credentialFile: string }, applicationId: string): Promise<string> {
  let stored: Json;
  try {
    stored = JSON.parse(await readFile(endpoint.credentialFile, "utf8")) as Json;
  } catch {
    fail(409, "credential_missing", "The application credential file is unavailable");
  }
  if (stored.applicationId !== applicationId || typeof stored.credential !== "string") {
    fail(409, "credential_missing", "The application credential does not match this environment");
  }
  return stored.credential;
}

async function clientFor(config: EvalsConfig, pool: Pool, sandboxId: string): Promise<{
  client: ApplicationClient;
  detail: SandboxDetail;
  workspace: WorkspaceRef;
  environment: ReturnType<typeof environmentRuntime>;
}> {
  const detail = await getSandbox(pool, sandboxId);
  if (!detail) fail(404, "not_found", "Environment not found");
  const environment = environmentRuntime(detail);
  const workspace = detail.workspaceRefs.find((item) =>
    item.productWorkspaceId === environment.organizationId) ?? detail.workspaceRefs[0];
  if (!workspace) fail(409, "workspace_missing", "The API environment has no workspace reference");
  const secret = await credential(
    { credentialFile: environment.credentialFile },
    environment.applicationId,
  );
  return {
    client: new ApplicationClient({ baseUrl: environment.baseUrl, credential: secret }),
    detail,
    workspace,
    environment,
  };
}

function applicationFailure(error: unknown): never {
  if (error instanceof ApplicationApiError) {
    if (error.statusCode === 401) {
      fail(400, "credential_invalid", "The application credential was rejected");
    }
    if (error.statusCode === 403) {
      fail(403, "scope_denied", error.message);
    }
    fail(error.statusCode >= 500 ? 502 : 400, error.code, error.message);
  }
  throw error;
}

function environmentName(value: unknown): string {
  return text(value, "name", 120);
}

async function storeCredential(
  config: EvalsConfig,
  environmentId: string,
  data: { applicationId: string; organizationId: string; baseUrl: string; credential: string },
): Promise<string> {
  const file = credentialPath(config, environmentId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  await chmod(file, 0o600);
  return file;
}

async function ownerSessionFor(
  config: EvalsConfig,
  pool: Pool,
  baseUrl: string,
): Promise<{ detail: SandboxDetail; session: OwnerSession }> {
  const target = baseUrl.replace(/\/+$/, "");
  const sandboxes = await listSandboxes(pool, 200);
  for (const detail of sandboxes) {
    const runtime = detail.sandbox.runtime as Json;
    if (detail.sandbox.status !== "ready" || runtime.kind === "api") continue;
    if (typeof runtime.apiUrl !== "string" ||
        runtime.apiUrl.replace(/\/+$/, "") !== target) continue;
    try {
      return { detail, session: await readOwnerSession(config, detail) };
    } catch {
      continue;
    }
  }
  fail(
    409,
    "owner_session_required",
    "Connect a sandbox for this base URL before creating a test organization",
  );
}

/**
 * Create an isolated test organization in a deployment Evals already has an owner
 * session for, then enroll an application and connect it. The caller never handles
 * the organization, application or credential.
 */
export async function createTestApiEnvironment(
  config: EvalsConfig,
  pool: Pool,
  raw: unknown,
): Promise<{
  environment: SandboxDetail;
  agents: number;
  organization: { id: string; name: string };
  agent: { id: string; name: string };
}> {
  const input = (raw ?? {}) as Json;
  const name = environmentName(input.name);
  const baseUrlText = text(input.baseUrl, "baseUrl", 2_000);
  let baseUrl: string;
  try {
    baseUrl = normalizeApplicationUrl(baseUrlText);
  } catch (error) {
    if (error instanceof ApplicationApiError) fail(400, error.code, error.message);
    throw error;
  }
  const organizationName =
    optionalText(input.organizationName, "organizationName", 120) ?? `${name} org`;
  const agentName =
    optionalText(input.agentName, "agentName", 120) ?? `${name} agent`;
  const { session } = await ownerSessionFor(config, pool, baseUrl);

  let organizationId: string;
  let agentId: string;
  let applicationId: string;
  let secret: string;
  try {
    const organization = await ownerRequest(
      session,
      "agents_session",
      "POST",
      "/api/organizations",
      { name: organizationName },
    );
    const org = organization.organization as Json | undefined;
    if (typeof org?.id !== "string") throw new Error("The product did not create the organization");
    organizationId = org.id;

    const createdAgent = await ownerRequest(
      session,
      "agents_session",
      "POST",
      `/api/organizations/${encodeURIComponent(organizationId)}/agents`,
      { name: agentName },
    );
    const agent = createdAgent.agent as Json | undefined;
    if (typeof agent?.id !== "string") throw new Error("The product did not create the agent");
    agentId = agent.id;

    const application = await ownerRequest(
      session,
      "agents_session",
      "POST",
      `/api/organizations/${encodeURIComponent(organizationId)}/applications`,
      {
        name: `${name} application`,
        agentIds: [agentId],
        scopes: ["agents:read", "agents:manage", "agents:publish"],
      },
    );
    const app = application.application as Json | undefined;
    const credentialValue = application.credential as Json | undefined;
    if (typeof app?.id !== "string" || typeof credentialValue?.secret !== "string") {
      throw new Error("The product did not create the application credential");
    }
    applicationId = app.id;
    secret = credentialValue.secret;
  } catch (error) {
    if (error instanceof ProductAgentError) {
      if (error.statusCode === 401) {
        fail(409, "owner_session_expired", "The owner session expired; refresh the sandbox session and retry");
      }
      if (error.statusCode === 403) {
        fail(409, "owner_session_forbidden", "The owner session cannot create a test organization");
      }
      fail(502, "test_org_failed", error.message);
    }
    fail(502, "test_org_failed", error instanceof Error ? error.message : "Test organization creation failed");
  }

  const environmentId = randomUUID();
  const file = await storeCredential(config, environmentId, {
    applicationId,
    organizationId,
    baseUrl,
    credential: secret,
  });
  const environment = await createApiEnvironment(pool, {
    id: environmentId,
    name,
    baseUrl,
    organizationId,
    applicationId,
    credentialFile: file,
    workspaceLabel: organizationName,
  }).catch(async (error: unknown) => {
    await rm(dirname(file), { recursive: true, force: true });
    throw error;
  });

  const workspace = environment.workspaceRefs[0];
  if (workspace) {
    try {
      const client = new ApplicationClient({ baseUrl, credential: secret });
      const created = await client.inspectAgent(agentId);
      await createAgentRef(pool, environmentId, {
        workspaceRefId: workspace.id,
        productAgentId: created.id,
        productVersionId: created.version.id,
        sourceIds: [],
        compositionDigest: digest({ kind: "bootstrap", agentId }),
        modelRoutesDigest: digest({ selection: { kind: "organization_default" } }),
      });
    } catch {
      // The environment is still connected; the agent can be referenced later.
    }
  }

  return {
    environment,
    agents: 1,
    organization: { id: organizationId, name: organizationName },
    agent: { id: agentId, name: agentName },
  };
}

/** Register a deployed product reached through an existing application credential. */
export async function connectApiEnvironment(
  config: EvalsConfig,
  pool: Pool,
  raw: unknown,
): Promise<{ environment: SandboxDetail; agents: number }> {
  const input = (raw ?? {}) as Json;
  const name = environmentName(input.name);
  const baseUrlText = text(input.baseUrl, "baseUrl", 2_000);
  let baseUrl: string;
  try {
    baseUrl = normalizeApplicationUrl(baseUrlText);
  } catch (error) {
    if (error instanceof ApplicationApiError) fail(400, error.code, error.message);
    throw error;
  }
  const organizationId = text(input.organizationId, "organizationId", 200);
  const applicationId = text(input.applicationId, "applicationId", 200);
  const secret = text(input.credential, "credential", 500);
  const label = optionalText(input.label, "label", 200);

  const client = new ApplicationClient({ baseUrl, credential: secret });
  let agents: ApplicationAgentSummary[];
  try {
    agents = await client.listAgents();
  } catch (error) {
    applicationFailure(error);
  }

  const environmentId = randomUUID();
  const file = await storeCredential(config, environmentId, {
    applicationId,
    organizationId,
    baseUrl,
    credential: secret,
  });

  const environment = await createApiEnvironment(pool, {
    id: environmentId,
    name,
    baseUrl,
    organizationId,
    applicationId,
    credentialFile: file,
    ...(label ? { workspaceLabel: label } : {}),
  }).catch(async (error: unknown) => {
    await rm(dirname(file), { recursive: true, force: true });
    throw error;
  });
  return { environment, agents: agents.length };
}

export async function listApiAgents(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
): Promise<ApiAgent[]> {
  const { client } = await clientFor(config, pool, sandboxId);
  let agents: ApplicationAgentSummary[];
  try {
    agents = await client.listAgents();
  } catch (error) {
    applicationFailure(error);
  }
  const refs = await listAgentRefs(pool, sandboxId, true);
  const result: ApiAgent[] = [];
  for (const agent of agents) {
    let detail: ApplicationAgentDetail | null = null;
    try {
      detail = await client.inspectAgent(agent.id);
    } catch {
      detail = null;
    }
    const ref = detail
      ? refs.find((item) => item.productAgentId === agent.id && item.productVersionId === detail!.version.id)
      : refs.find((item) => item.productAgentId === agent.id && !item.retiredAt);
    result.push({
      id: agent.id,
      name: agent.name,
      draftRevision: detail?.draftRevision ?? 0,
      version: detail?.version ?? null,
      agentRefId: ref?.id ?? null,
    });
  }
  return result;
}

export async function createApiAgent(
  config: EvalsConfig,
  pool: Pool,
  sandboxId: string,
  raw: unknown,
): Promise<ApiAgentCreated> {
  const input = (raw ?? {}) as Json;
  const name = text(input.name, "name", 120);
  const purpose = optionalText(input.purpose, "purpose", 600);
  const instructions = text(input.instructions, "instructions", 8_000);
  if (input.configuration !== undefined &&
      (!input.configuration || typeof input.configuration !== "object" || Array.isArray(input.configuration))) {
    fail(400, "invalid_configuration", "configuration must be a JSON object");
  }
  const configuration = input.configuration as Json | undefined;
  const publish = input.publish !== false;

  const { client, workspace } = await clientFor(config, pool, sandboxId);

  let created: { id: string; name: string; draftRevision: number };
  try {
    created = await client.createAgent({
      name,
      ...(purpose ? { purpose } : {}),
      instructions,
      operationId: randomUUID(),
    });
  } catch (error) {
    applicationFailure(error);
  }

  let revision = created.draftRevision;
  if (configuration) {
    try {
      const preview = await client.previewAgent(created.id, configuration);
      if (!preview.ready) {
        fail(
          400,
          "configuration_invalid",
          preview.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
        );
      }
      const updated = await client.updateAgent(created.id, {
        configuration,
        expectedRevision: revision,
      });
      revision = updated.draftRevision;
    } catch (error) {
      if (error instanceof ApplicationApiError) applicationFailure(error);
      throw error;
    }
  }

  if (!publish) {
    fail(400, "publish_required", "API agents must be published so the environment can reference them");
  }

  let version: { id: string; number: number; createdAt: string };
  try {
    version = await client.publishAgent(created.id, revision);
  } catch (error) {
    applicationFailure(error);
  }

  const refInput = {
    workspaceRefId: workspace.id,
    productAgentId: created.id,
    productVersionId: version.id,
    sourceIds: Array.isArray(configuration?.sourceRevisionIds)
      ? configuration!.sourceRevisionIds.filter((id: unknown): id is string => typeof id === "string")
      : [],
    compositionDigest: digest(configuration ?? { name, purpose, instructions }),
    modelRoutesDigest: digest(configuration?.model ?? { selection: { kind: "organization_default" } }),
  };
  let agentRef: AgentRef;
  try {
    agentRef = await createAgentRef(pool, sandboxId, refInput);
  } catch (error) {
    if ((error as { code?: string }).code !== "AGENT_REF_EXISTS") throw error;
    const existing = (await listAgentRefs(pool, sandboxId, true)).find((item) =>
      item.productAgentId === refInput.productAgentId &&
      item.productVersionId === refInput.productVersionId);
    if (!existing) throw error;
    agentRef = existing;
  }

  return {
    agent: {
      id: created.id,
      name: created.name,
      draftRevision: revision,
      version,
      agentRefId: agentRef.id,
    },
    agentRef,
  };
}
