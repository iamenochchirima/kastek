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
  getSandbox,
  listAgentRefs,
  listSandboxes,
} from "./store.js";
import { captureSandboxVersion } from "./version.js";

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
    if (error instanceof SandboxGuardError) {
      return reply.code(422).send({
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
    if (product !== "agents") {
      throw new HttpError(
        400,
        "unsupported_product",
        "Phase 1 only supports the Agents product",
      );
    }
    const manifest = await captureSandboxVersion(config, {
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
    });
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

  return app;
}
