import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { GROWTH_AGENT_COMMAND_PATH,GrowthAgentContractError,parseGrowthAgentCommand } from "@kasitek-labs/contracts";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { GrowthExecutionService } from "./growth-execution";
import { GrowthServiceAuth,type GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import type { GrowthProductRuntime } from "../../execution/products/growth-runtime";
export function registerGrowthProductRoutes(app:FastifyInstance,options:{pool:Pool;trust?:GrowthServiceTrust;runtime?:GrowthProductRuntime}) {
  const auth=options.trust?new GrowthServiceAuth(options.trust):undefined;
  const service=options.trust?new GrowthExecutionService(options.pool,options.trust,options.runtime):undefined;
  app.post(GROWTH_AGENT_COMMAND_PATH,async request=>{
    if(!auth||!service)throw new PlatformError("PRODUCT_INTEGRATION_UNAVAILABLE",503,"Growth integration is not configured");
    let command;
    try {command=parseGrowthAgentCommand(request.body);}catch(error){if(error instanceof GrowthAgentContractError)throw new PlatformError("INVALID_PRODUCT_COMMAND",400,"Check the command fields");throw error;}
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if(!bearer)throw new PlatformError("PRODUCT_SERVICE_DENIED",401,"Product service authentication is required");
    const verified=await auth.verify(bearer,command),digest=requestDigest(command);
    await options.pool.query("INSERT INTO agents_platform.product_service_assertions(product,client_id,jti,request_digest,expires_at) VALUES('growth',$1,$2,$3,$4) ON CONFLICT DO NOTHING",[verified.clientId,verified.jti,digest,verified.expiresAt]);
    const row=(await options.pool.query("SELECT request_digest FROM agents_platform.product_service_assertions WHERE product='growth' AND client_id=$1 AND jti=$2",[verified.clientId,verified.jti])).rows[0];
    if(row?.request_digest!==digest)throw new PlatformError("PRODUCT_ASSERTION_CONFLICT",409,"The service assertion was reused for different input");
    return service.execute(command);
  });
}
