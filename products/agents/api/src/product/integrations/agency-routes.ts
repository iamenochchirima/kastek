import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { AGENCY_AGENT_COMMAND_PATH, AGENCY_AGENT_MODEL_PATH, AgencyAgentContractError, parseAgencyAgentCommand } from "@kasitek-labs/contracts";
import { z } from "zod";
import { GrowthServiceAuth, type GrowthServiceTrust } from "../../adapters/products/growth-service-auth";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { ProductRuntime } from "../../execution/products/product-runtime";
import { AgencyExecutionService } from "./agency-execution";
import { recordProductServiceAssertion } from "./product-service-receipt";
import { ModelCredentialVault, modelApiKeySchema } from "../../infrastructure/model-credential-vault";
import { connectionVaultFromEnvironment } from "../../infrastructure/vault";
import { provisionProductModel } from "./growth-model-provisioning";
import { ProductActionClient } from "../../adapters/products/product-action-client";

const modelConfiguration=z.strictObject({version:z.literal("1"),operation:z.literal("model.configure"),requestId:z.uuid(),tenantId:z.string().min(1).max(256),clientId:z.string().min(1).max(256),
  actor:z.strictObject({issuer:z.url(),subject:z.string().min(1).max(512)}),input:z.strictObject({providerId:z.string().min(1).max(64),modelId:z.string().min(1).max(256),apiKey:modelApiKeySchema,endpoint:z.url().optional()})});

export function agencyServiceTrustFromEnvironment(env:NodeJS.ProcessEnv=process.env):GrowthServiceTrust|undefined {
  const keys=env.AGENCY_AGENTS_PUBLIC_KEYS_JSON?JSON.parse(env.AGENCY_AGENTS_PUBLIC_KEYS_JSON):env.AGENCY_AGENTS_PUBLIC_KEY?{[env.AGENCY_AGENTS_KEY_ID??"agency-v1"]:env.AGENCY_AGENTS_PUBLIC_KEY}:undefined;
  if(!keys)return;
  const issuer=env.AGENCY_AGENTS_ISSUER??"https://agency.kasitek.co.za";
  return {issuer,actorIssuer:env.AGENCY_IDENTITY_ISSUER??issuer+"/identity",keys,controlClientId:"agency-control",
    controlKeys:env.AGENCY_AGENTS_CONTROL_PUBLIC_KEYS_JSON?JSON.parse(env.AGENCY_AGENTS_CONTROL_PUBLIC_KEYS_JSON):undefined};
}

export function registerAgencyProductRoutes(app:FastifyInstance,options:{pool:Pool;runtime?:ProductRuntime;trust?:GrowthServiceTrust}){
  const auth=options.trust?new GrowthServiceAuth(options.trust,"agencies","agency-api"):undefined;
  const service=options.trust&&options.runtime?new AgencyExecutionService(options.pool,options.trust.issuer,options.runtime):undefined;
  app.post(AGENCY_AGENT_COMMAND_PATH,async request=>{
    if(!auth||!service)throw new PlatformError("PRODUCT_INTEGRATION_UNAVAILABLE",503,"Agency execution is not configured");
    let command;try{command=parseAgencyAgentCommand(request.body);}catch(error){if(error instanceof AgencyAgentContractError)throw new PlatformError("INVALID_PRODUCT_COMMAND",400,"Check the command fields");throw error;}
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if(!bearer)throw new PlatformError("PRODUCT_SERVICE_DENIED",401,"Product service authentication is required");
    const verified=await auth.verify(bearer,command);
    await recordProductServiceAssertion(options.pool,"agencies",verified,command);
    return service.execute(command);
  });
  app.post(AGENCY_AGENT_MODEL_PATH,{bodyLimit:32768},async request=>{
    const vault=connectionVaultFromEnvironment();
    if(!auth||!service||!vault||!process.env.AGENCY_PRODUCT_API_URL||!process.env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY)throw new PlatformError("PRODUCT_PROVISION_UNAVAILABLE",503,"Agency model setup is unavailable");
    const parsed=modelConfiguration.safeParse(request.body);if(!parsed.success)throw new PlatformError("INVALID_PRODUCT_MODEL",400,"Check the model configuration");
    const input=parsed.data,bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if(!bearer)throw new PlatformError("PRODUCT_SERVICE_DENIED",401,"Model setup authentication is required");
    const verified=await auth.verify(bearer,input);await recordProductServiceAssertion(options.pool,"agencies",verified,input);
    const client=new ProductActionClient({origin:process.env.AGENCY_PRODUCT_API_URL,privateKey:process.env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY.replace(/\\n/g,"\n"),
      issuer:process.env.AGENTS_PRODUCT_ACTION_ISSUER??"https://agents.kasitek.co.za",keyId:process.env.AGENTS_PRODUCT_ACTION_KEY_ID??"agents-v1",environment:process.env.NODE_ENV});
    const authorized=await client.authorizeOrigin({version:"1",product:"agencies",requestId:input.requestId,taskId:input.requestId,conversationId:input.requestId,
      tenantId:input.tenantId,clientId:input.clientId,actor:input.actor,purpose:"configure_model"});
    if(authorized.authorized!==true)throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Agency model setup is unavailable");
    const result=await provisionProductModel(options.pool,new ModelCredentialVault(vault),"agencies",{tenantId:input.tenantId,...input.input},
      {replaceExisting:true,requestIdentity:{id:input.requestId,digest:requestDigest(input)}});
    request.log.info({event:"product.model.configured",product:"agencies",tenant_id:input.tenantId,connection_id:result.connectionId,model_id:result.modelId,request_id:input.requestId},"Product model configured");
    const readiness=await service.readiness({version:"1",requestId:input.requestId,tenantId:input.tenantId,clientId:input.clientId,actor:input.actor,operation:"readiness.get",input:{}});
    return {...readiness,modelId:result.modelId,profileRevision:result.revision};
  });
}
