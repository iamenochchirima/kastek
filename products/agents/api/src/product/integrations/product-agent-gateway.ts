import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { GrowthAgentCommand, ProductAgentCommand } from "@kasitek-labs/contracts";
import { ProductAgentContractError, parseProductAgentCommand } from "@kasitek-labs/contracts";
import { PlatformError } from "../../contracts/contracts";
import { GrowthServiceAuth, type GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import type { GrowthProductRuntime } from "../../execution/products/growth-runtime";
import { GrowthExecutionService } from "./growth-execution";
import { recordProductServiceAssertion } from "./product-service-receipt";

function targetFeature(command: ProductAgentCommand): string {
  const target = "target" in command.input ? command.input.target : undefined;
  if (!target || target.kind !== "product_feature") {
    throw new PlatformError("PRODUCT_TARGET_UNAVAILABLE", 400, "A Growth feature target is required");
  }
  return target.featureId;
}

/**
 * Maps the shared product contract onto the existing Growth admission and run service.
 * The Growth-specific wire contract is not used here; only the internal service is reused.
 */
export function toGrowthCommand(command: ProductAgentCommand): GrowthAgentCommand {
  const base = { version: "1" as const, requestId: command.requestId, tenantId: command.tenantId, actor: command.actor };
  switch (command.operation) {
    case "conversations.create":
      return { ...base, operation: "conversations.create", input: { featureId: targetFeature(command), ...(command.input.title ? { title: command.input.title } : {}), context: command.input.context ?? null } } as GrowthAgentCommand;
    case "conversations.get":
      return { ...base, operation: "conversations.get", input: { conversationId: command.input.conversationId, ...(command.input.cursor ? { cursor: command.input.cursor } : {}), ...(command.input.limit ? { limit: command.input.limit } : {}) } } as GrowthAgentCommand;
    case "conversations.list": {
      const target = command.input.target;
      return { ...base, operation: "conversations.list", input: { ...(target?.kind === "product_feature" ? { featureId: target.featureId } : {}), ...(command.input.search ? { search: command.input.search } : {}), ...(command.input.cursor ? { cursor: command.input.cursor } : {}), ...(command.input.limit ? { limit: command.input.limit } : {}) } } as GrowthAgentCommand;
    }
    case "conversations.context":
      return { ...base, operation: "conversations.context", input: { conversationId: command.input.conversationId, context: command.input.context } } as GrowthAgentCommand;
    case "runs.start":
      return { ...base, operation: "turns.submit", input: { conversationId: command.input.conversationId, text: command.input.message, context: command.input.context ?? null } } as GrowthAgentCommand;
    case "runs.get":
      return { ...base, operation: "tasks.get", input: { taskId: command.input.taskId } } as GrowthAgentCommand;
    case "runs.list":
      return { ...base, operation: "tasks.list", input: { ...(command.input.conversationId ? { conversationId: command.input.conversationId } : {}), ...(command.input.state ? { state: command.input.state } : {}), ...(command.input.search ? { search: command.input.search } : {}), ...(command.input.cursor ? { cursor: command.input.cursor } : {}), ...(command.input.limit ? { limit: command.input.limit } : {}) } } as GrowthAgentCommand;
    case "runs.activity":
      return { ...base, operation: "tasks.observe", input: { taskId: command.input.taskId, ...(command.input.childTaskId ? { childTaskId: command.input.childTaskId } : {}), ...(command.input.cursor ? { cursor: command.input.cursor } : {}), ...(command.input.operationCursor ? { operationCursor: command.input.operationCursor } : {}), ...(command.input.limit ? { limit: command.input.limit } : {}) } } as GrowthAgentCommand;
    case "runs.events":
      return { ...base, operation: "tasks.events", input: { taskId: command.input.taskId, ...(command.input.cursor ? { cursor: command.input.cursor } : {}), ...(command.input.limit ? { limit: command.input.limit } : {}) } } as GrowthAgentCommand;
    case "runs.steer":
      return { ...base, operation: "tasks.instructions", input: { taskId: command.input.taskId, instruction: command.input.instruction } } as GrowthAgentCommand;
    case "runs.cancel":
      return { ...base, operation: "tasks.cancel", input: { taskId: command.input.taskId } } as GrowthAgentCommand;
    case "runs.continue":
      return { ...base, operation: "tasks.continue", input: { taskId: command.input.taskId } } as GrowthAgentCommand;
    case "reviews.list":
      return { ...base, operation: "reviews.list", input: { taskId: command.input.taskId } } as GrowthAgentCommand;
    case "reviews.decide":
      return { ...base, operation: "reviews.decide", input: { taskId: command.input.taskId, reviewId: command.input.reviewId, payloadDigest: command.input.payloadDigest, decision: command.input.decision } } as GrowthAgentCommand;
    case "artifacts.list":
      return { ...base, operation: "artifacts.list", input: { taskId: command.input.taskId, ...(command.input.childTaskId ? { childTaskId: command.input.childTaskId } : {}) } } as GrowthAgentCommand;
    case "artifacts.get":
      return { ...base, operation: "artifacts.get", input: { taskId: command.input.taskId, artifactId: command.input.artifactId, ...(command.input.childTaskId ? { childTaskId: command.input.childTaskId } : {}), ...(command.input.offset ? { offset: command.input.offset } : {}) } } as GrowthAgentCommand;
    case "tasks.export":
      return { ...base, operation: "tasks.export", input: { taskId: command.input.taskId } } as GrowthAgentCommand;
    case "models.list":
      return { ...base, operation: "models.list", input: { featureId: targetFeature(command) } } as GrowthAgentCommand;
    case "models.select":
      return { ...base, operation: "models.select", input: { featureId: targetFeature(command), expectedRevision: command.input.expectedRevision, selection: command.input.selection } } as GrowthAgentCommand;
  }
}

export class ProductAgentGateway {
  constructor(private readonly execution: GrowthExecutionService) {}
  async execute(command: ProductAgentCommand): Promise<unknown> {
    return this.execution.execute(toGrowthCommand(command));
  }
}

export function registerProductAgentGateway(app: FastifyInstance, options: {
  pool: Pool;
  trust?: GrowthServiceTrust;
  runtime?: GrowthProductRuntime;
  execution?: GrowthExecutionService;
}): void {
  const auth = options.trust ? new GrowthServiceAuth(options.trust) : undefined;
  const gateway = options.trust ? new ProductAgentGateway(options.execution ?? new GrowthExecutionService(options.pool, options.trust, options.runtime)) : undefined;
  app.post("/internal/v1/products/:product/agent-gateway", { bodyLimit: 4_194_304 }, async request => {
    const product = (request.params as { product?: string }).product;
    if (product !== "growth" || !auth || !gateway) {
      throw new PlatformError("PRODUCT_INTEGRATION_UNAVAILABLE", 503, "Product agent gateway is not configured");
    }
    let command: ProductAgentCommand;
    try {
      command = parseProductAgentCommand(request.body);
    } catch (error) {
      if (error instanceof ProductAgentContractError) throw new PlatformError("INVALID_PRODUCT_COMMAND", 400, "Check the command fields");
      throw error;
    }
    if (command.product !== product) throw new PlatformError("PRODUCT_SERVICE_DENIED", 401, "Product service request is invalid");
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if (!bearer) throw new PlatformError("PRODUCT_SERVICE_DENIED", 401, "Product service authentication is required");
    const verified = await auth.verify(bearer, command);
    await recordProductServiceAssertion(options.pool, "growth", verified, command);
    return gateway.execute(command);
  });
}
