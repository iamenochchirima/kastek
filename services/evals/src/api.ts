import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import type { Pool } from "pg";
import type { EvalsConfig } from "./config.js";
import { SandboxGuardError } from "./guard.js";
import {
  addWorkspaceRef,
  AgentRefError,
  createAgentRef,
  createSandbox,
  getAgentRef,
  getOutcomeRef,
  getSandbox,
  listAgentRefs,
  listOutcomeRefs,
  listSandboxes,
  createOutcomeRef,
  OutcomeRefError,
  type OutcomeKind,
  type OutcomeStatus,
  appendInteractiveTurn,
  createInteractiveSession,
  getInteractiveSession,
  InteractiveSessionError,
  listInteractiveSessions,
  SandboxPairError,
  type InteractiveSessionState,
} from "./store.js";
import { captureSandboxVersion } from "./version.js";
import { provisionLocalSandbox } from "./provisioner/local.js";
import { provisionGrowthPair } from "./provisioner/growth.js";
import { listProductAgents, ProductAgentError } from "./product-agents.js";
import {
  listAgentModels,
  ProductModelError,
  selectAgentModel,
} from "./product-models.js";
import { restartSandboxRuntime } from "./runtime.js";
import { SandboxSyncError, syncSandbox } from "./sandbox-sync.js";
import {
  AgentProfileError,
  createProfile,
  createProfileVersion,
  getProfile,
  listProfiles,
  startAgentProfileSetup,
} from "./agent-profile-service.js";
import {
  chatWithProductAgent,
  ProductChatError,
  productMessages,
} from "./product-chat.js";
import {
  deleteAllSandboxes,
  deleteSandbox,
  SandboxLifecycleError,
} from "./lifecycle.js";

class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface BuildApiOptions {
  logger?: boolean;
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b) && left.length === right.length;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_body", "Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function optionalText(
  value: unknown,
  name: string,
  max: number,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `${name} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new HttpError(
      400,
      "invalid_field",
      `${name} must be between 1 and ${max} characters`,
    );
  }
  return normalized;
}

function requiredText(value: unknown, name: string, max: number): string {
  const result = optionalText(value, name, max);
  if (!result) {
    throw new HttpError(400, "invalid_field", `${name} is required`);
  }
  return result;
}

function uuid(value: string, name: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new HttpError(400, "invalid_id", `${name} must be a UUID`);
  }
  return value;
}

function adapterVersions(
  value: unknown,
): Record<string, string> | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      "invalid_field",
      "adapterVersions must be an object",
    );
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      throw new HttpError(
        400,
        "invalid_field",
        "adapterVersions values must be strings",
      );
    }
    result[key] = item;
  }
  return result;
}


function sourceIds(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 200) {
    throw new HttpError(400, "invalid_field", "sourceIds must be an array of at most 200 strings");
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 200) {
      throw new HttpError(400, "invalid_field", "sourceIds values must be bounded strings");
    }
    return item.trim();
  });
}

function sha256(value: unknown, name: string): string {
  const normalized = requiredText(value, name, 64);
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new HttpError(400, "invalid_field", `${name} must be a SHA-256 checksum`);
  }
  return normalized;
}

function optionalSha256(value: unknown, name: string): string | undefined {
  if (value == null) return undefined;
  return sha256(value, name);
}

function interactiveState(value: unknown): InteractiveSessionState {
  const normalized = requiredText(value, "state", 32) as InteractiveSessionState;
  if (!["active", "waiting_review", "completed", "failed", "cancelled"].includes(normalized)) {
    throw new HttpError(
      400,
      "invalid_field",
      "state must be active, waiting_review, completed, failed or cancelled",
    );
  }
  return normalized;
}

function workspaceRef(
  value: unknown,
): { productWorkspaceId: string; label?: string } | undefined {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(
      400,
      "invalid_field",
      "workspaceRef must be an object",
    );
  }
  const input = value as Record<string, unknown>;
  const productWorkspaceId = requiredText(
    input.productWorkspaceId,
    "workspaceRef.productWorkspaceId",
    200,
  );
  const label = optionalText(input.label, "workspaceRef.label", 200);
  return { productWorkspaceId, ...(label ? { label } : {}) };
}

function limit(value: unknown): number {
  if (value == null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new HttpError(400, "invalid_query", "limit must be between 1 and 200");
  }
  return parsed;
}

function authFailed(reply: FastifyReply) {
  return reply.code(401).send({
    error: "Unauthorized",
    code: "unauthorized",
  });
}

export function buildApi(
  pool: Pool,
  config: EvalsConfig,
  options: BuildApiOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: process.env.EVALS_LOG_LEVEL ?? "info",
            redact: ["req.headers.authorization"],
          },
    bodyLimit: 65_536,
    trustProxy: false,
  });

  app.addHook(
    "onRequest",
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (request.url === "/v1/health") return;
      const header = request.headers.authorization;
      const token =
        header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
      if (!token || !safeEqual(token, config.operatorToken)) {
        return authFailed(reply);
      }
    },
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SandboxSyncError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof AgentProfileError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof ProductModelError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof ProductAgentError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof ProductChatError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof SandboxLifecycleError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof SandboxGuardError) {
      return reply.code(422).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof SandboxPairError) {
      const status =
        error.code === "PAIR_CONFLICT" ? 409 :
        error.code === "SANDBOX_NOT_FOUND" ? 404 : 400;
      return reply.code(status).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof InteractiveSessionError) {
      const status =
        error.code === "SESSION_CONFLICT" || error.code === "TURN_CONFLICT" ? 409 :
        error.code === "SANDBOX_NOT_FOUND" || error.code === "SESSION_NOT_FOUND" ? 404 : 400;
      return reply.code(status).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof OutcomeRefError) {
      const status =
        error.code === "OUTCOME_REF_EXISTS" ? 409 :
        error.code === "SANDBOX_NOT_FOUND" || error.code === "AGENT_REF_NOT_FOUND" ? 404 : 400;
      return reply.code(status).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof AgentRefError) {
      const status =
        error.code === "AGENT_REF_EXISTS" ? 409 :
        error.code === "SANDBOX_NOT_FOUND" ? 404 : 400;
      return reply.code(status).send({
        error: error.message,
        code: error.code,
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        code: error.code,
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: "Request failed",
        code: "bad_request",
      });
    }
    request.log.error(
      { event: "request.failed", route: request.url.split("?")[0] },
      error instanceof Error ? error.message : "unknown",
    );
    return reply.code(500).send({
      error: "Evaluation service unavailable",
      code: "internal_error",
    });
  });

  app.get("/v1/health", async () => ({
    ok: true,
    service: "evals",
    version: "0.1.0",
  }));

  app.post("/v1/sandboxes", async (request, reply) => {
    const body = bodyObject(request.body);
    const product = body.product == null
      ? "agents"
      : requiredText(body.product, "product", 32);
    if (!["agents", "growth"].includes(product)) {
      throw new HttpError(
        400,
        "unsupported_product",
        "Supported products are agents and growth",
      );
    }
    const manifestOverrides = {
      codeRevision: optionalText(body.codeRevision, "codeRevision", 200),
      imageDigest: optionalText(body.imageDigest, "imageDigest", 200),
      schemaVersion: optionalText(body.schemaVersion, "schemaVersion", 120),
      migrationChecksum: optionalText(
        body.migrationChecksum,
        "migrationChecksum",
        64,
      ),
      configDigest: optionalText(body.configDigest, "configDigest", 64),
      runtimeVersion: optionalText(body.runtimeVersion, "runtimeVersion", 120),
      modelRoutesDigest: optionalText(
        body.modelRoutesDigest,
        "modelRoutesDigest",
        64,
      ),
      adapterVersions: adapterVersions(body.adapterVersions),
    };
    const manifestFor = (target: "agents" | "growth") =>
      captureSandboxVersion(config, manifestOverrides, target);
    if (body.provision === true) {
      if (!config.localProvisioning) {
        return reply.code(503).send({
          error: "Local sandbox provisioning is not configured",
          code: "PROVISIONING_UNAVAILABLE",
        });
      }
      if (body.workspaceRef != null) {
        throw new HttpError(400, "invalid_field", "workspaceRef cannot be supplied during provisioning");
      }
      const profile = requiredText(body.profile ?? "local", "profile", 32);
      if (profile !== "local") {
        throw new HttpError(400, "invalid_field", "profile must be local");
      }
      const workspaceName = requiredText(body.workspaceName, "workspaceName", 120);
      const label = optionalText(body.label, "label", 200);
      if (product === "growth") {
        const growthManifest = await manifestFor("growth");
        const agentsManifest = await manifestFor("agents");
        const growth = await createSandbox(pool, {
          product: "growth",
          manifest: growthManifest,
          status: "provisioning",
          profile,
          provisioningSteps: [
            { name: "agents", status: "pending" },
            { name: "database", status: "pending" },
            { name: "schema", status: "pending" },
            { name: "runtime", status: "pending" },
            { name: "workspace", status: "pending" },
            { name: "billing", status: "pending" },
            { name: "pairing", status: "pending" },
            { name: "agent-setup", status: "pending" },
          ],
        });
        const agents = await createSandbox(pool, {
          product: "agents",
          manifest: agentsManifest,
          status: "provisioning",
          profile,
          provisioningSteps: [
            { name: "database", status: "pending" },
            { name: "schema", status: "pending" },
            { name: "storage", status: "pending" },
            { name: "runtime", status: "pending" },
            { name: "workspace", status: "pending" },
            { name: "billing", status: "pending" },
          ],
        });
        void provisionGrowthPair(config, pool, {
          growthSandboxId: growth.sandbox.id,
          agentsSandboxId: agents.sandbox.id,
          workspaceName,
          ...(label ? { label } : {}),
        }).catch((error: unknown) => {
          request.log.error(
            { event: "sandbox.growth.provision.failed", sandboxId: growth.sandbox.id },
            error instanceof Error ? error.message : "unknown",
          );
        });
        return reply.code(202).send(growth);
      }
      const manifest = await manifestFor("agents");
      const detail = await createSandbox(pool, {
        product,
        manifest,
        status: "provisioning",
        profile,
        provisioningSteps: [
          { name: "database", status: "pending" },
          { name: "schema", status: "pending" },
          { name: "storage", status: "pending" },
          { name: "runtime", status: "pending" },
          { name: "workspace", status: "pending" },
          { name: "billing", status: "pending" },
        ],
      });
      void provisionLocalSandbox(config, pool, {
        sandboxId: detail.sandbox.id,
        workspaceName,
        ...(label ? { label } : {}),
      }).catch((error: unknown) => {
        request.log.error(
          { event: "sandbox.provision.failed", sandboxId: detail.sandbox.id },
          error instanceof Error ? error.message : "unknown",
        );
      });
      return reply.code(202).send(detail);
    }
    const manifest = await manifestFor(product as "agents" | "growth");
    const detail = await createSandbox(pool, {
      product,
      manifest,
      workspaceRef: workspaceRef(body.workspaceRef),
    });
    return reply.code(201).send(detail);
  });

  app.get("/v1/sandboxes", async (request) => {
    const query = request.query as { limit?: string };
    return { sandboxes: await listSandboxes(pool, limit(query.limit)) };
  });

  app.delete("/v1/sandboxes", async (request) => {
    const body = bodyObject(request.body);
    if (body.confirm !== "DELETE") {
      throw new HttpError(
        400,
        "confirmation_required",
        'Send {"confirm":"DELETE"} to delete all sandboxes',
      );
    }
    const result = await deleteAllSandboxes(config, pool);
    request.log.info(
      { event: "sandboxes.deleted", deleted: result.deleted, failed: result.failed.length },
      "All sandboxes deleted",
    );
    return result;
  });

  app.delete("/v1/sandboxes/:id", async (request) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    const result = await deleteSandbox(config, pool, sandboxId);
    request.log.info(
      {
        event: "sandbox.deleted",
        sandboxId,
        deleted: result.deleted,
        stoppedProcesses: result.stoppedProcesses,
        droppedDatabases: result.droppedDatabases,
      },
      "Sandbox deleted",
    );
    return result;
  });

  app.get("/v1/sandboxes/:id", async (request, reply) => {
    const params = request.params as { id: string };
    const detail = await getSandbox(pool, uuid(params.id, "id"));
    if (!detail) {
      return reply.code(404).send({
        error: "Sandbox not found",
        code: "not_found",
      });
    }
    return detail;
  });

  app.post("/v1/sandboxes/:id/workspaces", async (request, reply) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    const ref = await addWorkspaceRef(pool, uuid(params.id, "id"), {
      productWorkspaceId: requiredText(
        body.productWorkspaceId,
        "productWorkspaceId",
        200,
      ),
      label: optionalText(body.label, "label", 200),
    });
    if (!ref) {
      return reply.code(404).send({
        error: "Sandbox not found",
        code: "not_found",
      });
    }
    return reply.code(201).send({ workspaceRef: ref });
  });

  app.post("/v1/sandboxes/:id/agents", async (request, reply) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    const body = bodyObject(request.body);
    const ref = await createAgentRef(pool, sandboxId, {
      workspaceRefId: uuid(
        requiredText(body.workspaceRefId, "workspaceRefId", 64),
        "workspaceRefId",
      ),
      productAgentId: requiredText(body.productAgentId, "productAgentId", 200),
      productVersionId: requiredText(body.productVersionId, "productVersionId", 200),
      sourceIds: sourceIds(body.sourceIds),
      compositionDigest: sha256(body.compositionDigest, "compositionDigest"),
      modelRoutesDigest: sha256(body.modelRoutesDigest, "modelRoutesDigest"),
    });
    return reply.code(201).send({ agentRef: ref });
  });

  app.get("/v1/sandboxes/:id/agents", async (request, reply) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    if (!(await getSandbox(pool, sandboxId))) {
      return reply.code(404).send({
        error: "Sandbox not found",
        code: "not_found",
      });
    }
    return { agentRefs: await listAgentRefs(pool, sandboxId) };
  });

  app.get("/v1/sandboxes/:id/agents/:agentRefId", async (request, reply) => {
    const params = request.params as { id: string; agentRefId: string };
    const sandboxId = uuid(params.id, "id");
    const ref = await getAgentRef(
      pool,
      sandboxId,
      uuid(params.agentRefId, "agentRefId"),
    );
    if (!ref) {
      return reply.code(404).send({
        error: "Agent reference not found",
        code: "not_found",
      });
    }
    return { agentRef: ref };
  });

  app.post("/v1/sandboxes/:id/outcomes", async (request, reply) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    const body = bodyObject(request.body);
    const kind = requiredText(body.kind, "kind", 32) as OutcomeKind;
    if (!["enquiry", "booking", "record"].includes(kind)) {
      throw new HttpError(400, "invalid_field", "kind must be enquiry, booking or record");
    }
    const status = requiredText(body.status, "status", 32) as OutcomeStatus;
    if (!["submitted", "completed", "unknown"].includes(status)) {
      throw new HttpError(400, "invalid_field", "status must be submitted, completed or unknown");
    }
    const outcome = await createOutcomeRef(pool, sandboxId, {
      workspaceRefId: uuid(
        requiredText(body.workspaceRefId, "workspaceRefId", 64),
        "workspaceRefId",
      ),
      agentRefId: uuid(
        requiredText(body.agentRefId, "agentRefId", 64),
        "agentRefId",
      ),
      kind,
      productOutcomeId: requiredText(body.productOutcomeId, "productOutcomeId", 200),
      productRecordId: optionalText(body.productRecordId, "productRecordId", 200),
      status,
      taskId: optionalText(body.taskId, "taskId", 200),
      requestDigest: sha256(body.requestDigest, "requestDigest"),
      responseDigest: sha256(body.responseDigest, "responseDigest"),
    });
    return reply.code(201).send({ outcomeRef: outcome });
  });

  app.get("/v1/sandboxes/:id/outcomes", async (request, reply) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    if (!(await getSandbox(pool, sandboxId))) {
      return reply.code(404).send({
        error: "Sandbox not found",
        code: "not_found",
      });
    }
    return { outcomeRefs: await listOutcomeRefs(pool, sandboxId) };
  });

  app.get("/v1/sandboxes/:id/outcomes/:outcomeRefId", async (request, reply) => {
    const params = request.params as { id: string; outcomeRefId: string };
    const sandboxId = uuid(params.id, "id");
    const outcome = await getOutcomeRef(
      pool,
      sandboxId,
      uuid(params.outcomeRefId, "outcomeRefId"),
    );
    if (!outcome) {
      return reply.code(404).send({
        error: "Outcome reference not found",
        code: "not_found",
      });
    }
    return { outcomeRef: outcome };
  });

  app.get("/v1/sandboxes/:id/agent-profiles", async (request) => {
    const params = request.params as { id: string };
    return { profiles: await listProfiles(pool, uuid(params.id, "id")) };
  });

  app.post("/v1/sandboxes/:id/agent-profiles", async (request, reply) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    const profile = await createProfile(
      pool,
      uuid(params.id, "id"),
      uuid(requiredText(body.workspaceRefId, "workspaceRefId", 64), "workspaceRefId"),
      body.spec,
    );
    return reply.code(201).send({ profile });
  });

  app.get("/v1/agent-profiles/:profileId", async (request) => {
    const params = request.params as { profileId: string };
    return getProfile(pool, uuid(params.profileId, "profileId"));
  });

  app.post("/v1/agent-profiles/:profileId/versions", async (request, reply) => {
    const params = request.params as { profileId: string };
    const body = bodyObject(request.body);
    const profile = await createProfileVersion(pool, uuid(params.profileId, "profileId"), body.spec);
    return reply.code(201).send({ profile });
  });

  app.post("/v1/agent-profiles/:profileId/apply", async (request, reply) => {
    const params = request.params as { profileId: string };
    const body = bodyObject(request.body);
    return reply.code(202).send(await startAgentProfileSetup(
      config,
      pool,
      uuid(params.profileId, "profileId"),
      requiredText(body.idempotencyKey, "idempotencyKey", 200),
    ));
  });

  app.get("/v1/sandboxes/:id/agents/:agentRefId/models", async (request) => {
    const params = request.params as { id: string; agentRefId: string };
    return listAgentModels(
      config,
      pool,
      uuid(params.id, "id"),
      uuid(params.agentRefId, "agentRefId"),
    );
  });

  app.post("/v1/sandboxes/:id/agents/:agentRefId/model", async (request) => {
    const params = request.params as { id: string; agentRefId: string };
    const body = bodyObject(request.body);
    const kind = requiredText(body.kind, "kind", 32);
    if (kind === "organization_default") {
      return selectAgentModel(
        config,
        pool,
        uuid(params.id, "id"),
        uuid(params.agentRefId, "agentRefId"),
        { kind },
      );
    }
    if (kind !== "connection") {
      throw new HttpError(400, "kind must be organization_default or connection", "invalid_field");
    }
    return selectAgentModel(
      config,
      pool,
      uuid(params.id, "id"),
      uuid(params.agentRefId, "agentRefId"),
      {
        kind,
        connectionId: requiredText(body.connectionId, "connectionId", 64),
        modelId: requiredText(body.modelId, "modelId", 256),
      },
    );
  });

  app.post("/v1/sandboxes/:id/sync", async (request) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    if (body.confirm !== "UPDATE") {
      throw new HttpError(400, 'Send {"confirm":"UPDATE"} to update this sandbox', "confirmation_required");
    }
    const sandboxId = uuid(params.id, "id");
    const result = await syncSandbox(config, pool, sandboxId);
    request.log.info(
      { event: "sandbox.synced", sandboxId, updateId: result.id, codeRevision: result.targetCodeRevision },
      "Sandbox synced",
    );
    return result;
  });

  app.post("/v1/sandboxes/:id/runtime/restart", async (request) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    const result = await restartSandboxRuntime(config, pool, sandboxId);
    request.log.info(
      { event: "sandbox.runtime.restart", sandboxId, result },
      "Sandbox runtime restarted",
    );
    return result;
  });

  app.get("/v1/sandboxes/:id/product-agents", async (request) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    return { agents: await listProductAgents(config, pool, sandboxId) };
  });

  app.post("/v1/sandboxes/:id/chat", async (request) => {
    const params = request.params as { id: string };
    const body = bodyObject(request.body);
    return chatWithProductAgent(config, pool, {
      sandboxId: uuid(params.id, "id"),
      agentRefId: uuid(
        requiredText(body.agentRefId, "agentRefId", 64),
        "agentRefId",
      ),
      ...(body.sessionId == null
        ? {}
        : { sessionId: uuid(requiredText(body.sessionId, "sessionId", 64), "sessionId") }),
      message: requiredText(body.message, "message", 131_072),
    });
  });

  app.get("/v1/sandboxes/:id/sessions/:sessionId/messages", async (request) => {
    const params = request.params as { id: string; sessionId: string };
    return {
      messages: await productMessages(
        config,
        pool,
        uuid(params.id, "id"),
        uuid(params.sessionId, "sessionId"),
      ),
    };
  });

  app.post("/v1/sandboxes/:id/sessions", async (request, reply) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    const body = bodyObject(request.body);
    const result = await createInteractiveSession(pool, sandboxId, {
      workspaceRefId: uuid(
        requiredText(body.workspaceRefId, "workspaceRefId", 64),
        "workspaceRefId",
      ),
      agentRefId: uuid(
        requiredText(body.agentRefId, "agentRefId", 64),
        "agentRefId",
      ),
      productConversationId: requiredText(
        body.productConversationId,
        "productConversationId",
        200,
      ),
      productTaskId: requiredText(body.productTaskId, "productTaskId", 200),
      inputDigest: sha256(body.inputDigest, "inputDigest"),
      outputDigest: optionalSha256(body.outputDigest, "outputDigest"),
      state: body.state == null ? "active" : interactiveState(body.state),
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post("/v1/sandboxes/:id/sessions/:sessionId/turns", async (request, reply) => {
    const params = request.params as { id: string; sessionId: string };
    const sandboxId = uuid(params.id, "id");
    const sessionId = uuid(params.sessionId, "sessionId");
    const body = bodyObject(request.body);
    const result = await appendInteractiveTurn(pool, sandboxId, sessionId, {
      productTaskId: requiredText(body.productTaskId, "productTaskId", 200),
      inputDigest: sha256(body.inputDigest, "inputDigest"),
      outputDigest: optionalSha256(body.outputDigest, "outputDigest"),
      state: interactiveState(body.state),
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get("/v1/sandboxes/:id/sessions", async (request, reply) => {
    const params = request.params as { id: string };
    const sandboxId = uuid(params.id, "id");
    const query = request.query as { limit?: string };
    if (!(await getSandbox(pool, sandboxId))) {
      return reply.code(404).send({
        error: "Sandbox not found",
        code: "not_found",
      });
    }
    return {
      sessions: await listInteractiveSessions(pool, sandboxId, limit(query.limit)),
    };
  });

  app.get("/v1/sandboxes/:id/sessions/:sessionId", async (request, reply) => {
    const params = request.params as { id: string; sessionId: string };
    const detail = await getInteractiveSession(
      pool,
      uuid(params.id, "id"),
      uuid(params.sessionId, "sessionId"),
    );
    if (!detail) {
      return reply.code(404).send({
        error: "Interactive session not found",
        code: "not_found",
      });
    }
    return detail;
  });

  return app;
}
