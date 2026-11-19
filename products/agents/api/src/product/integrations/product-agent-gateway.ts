import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";
import type { ProductAgentCommand } from "@kasitek-labs/contracts";
import { ProductAgentContractError, parseProductAgentCommand } from "@kasitek-labs/contracts";
import { PlatformError } from "../../contracts/contracts";
import { GrowthServiceAuth, type GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import type { GrowthProductRuntime } from "../../execution/products/growth-runtime";
import { GrowthExecutionService } from "./growth-execution";
import { recordProductServiceAssertion } from "./product-service-receipt";

export class ProductAgentGateway {
  constructor(private readonly execution: GrowthExecutionService) {}
  async execute(command: ProductAgentCommand): Promise<unknown> {
    return this.execution.execute(command);
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
