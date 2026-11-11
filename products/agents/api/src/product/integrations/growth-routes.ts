import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { GROWTH_AGENT_COMMAND_PATH,GrowthAgentContractError,parseGrowthAgentCommand } from "@kasitek-labs/contracts";
import { PlatformError } from "../../contracts/contracts";
import { recordProductServiceAssertion } from "./product-service-receipt";
import { GrowthExecutionService } from "./growth-execution";
import { growthUsageFeed } from "./growth-usage";
import { GrowthServiceAuth,type GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import type { GrowthProductRuntime } from "../../execution/products/growth-runtime";
const usageInput = z.strictObject({
  version: z.literal("1"),
  operation: z.literal("usage.read"),
  tenantId: z.string().min(1).max(128),
  since: z.string().min(20).max(40).nullable(),
  limit: z.number().int().min(1).max(200),
  actor: z.strictObject({ issuer: z.string().min(1).max(512), subject: z.string().min(1).max(512) }),
});
export function registerGrowthProductRoutes(app:FastifyInstance,options:{pool:Pool;trust?:GrowthServiceTrust;runtime?:GrowthProductRuntime}) {
  const auth=options.trust?new GrowthServiceAuth(options.trust):undefined;
  const service=options.trust?new GrowthExecutionService(options.pool,options.trust,options.runtime):undefined;
  app.post(GROWTH_AGENT_COMMAND_PATH,{bodyLimit:4_194_304},async request=>{
    if(!auth||!service)throw new PlatformError("PRODUCT_INTEGRATION_UNAVAILABLE",503,"Growth integration is not configured");
    let command;
    try {command=parseGrowthAgentCommand(request.body);}catch(error){if(error instanceof GrowthAgentContractError)throw new PlatformError("INVALID_PRODUCT_COMMAND",400,"Check the command fields");throw error;}
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if(!bearer)throw new PlatformError("PRODUCT_SERVICE_DENIED",401,"Product service authentication is required");
    const verified=await auth.verify(bearer,command);
    await recordProductServiceAssertion(options.pool,"growth",verified,command);
    return service.execute(command);
  });
  app.post("/internal/v1/products/growth/usage",{bodyLimit:16_384},async request=>{
    if(!auth)throw new PlatformError("PRODUCT_INTEGRATION_UNAVAILABLE",503,"Growth integration is not configured");
    let input;
    try {input=usageInput.parse(request.body);}catch{throw new PlatformError("INVALID_PRODUCT_COMMAND",400,"Check the usage request fields");}
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if(!bearer)throw new PlatformError("PRODUCT_SERVICE_DENIED",401,"Product service authentication is required");
    await auth.verify(bearer,input);
    return growthUsageFeed(options.pool,{tenantId:input.tenantId,since:input.since,limit:input.limit});
  });
}
