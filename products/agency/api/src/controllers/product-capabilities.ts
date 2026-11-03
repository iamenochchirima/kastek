import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { capabilityInvocation, verifyCapabilityService } from "../capabilities/authority.js";
import { readWorkspaceAgentMetadata } from "../capabilities/workspace-agent-metadata.js";
import { authorizeAgencyExecution } from "../capabilities/execution-authority.js";
import { bad } from "../error.js";
export function registerProductCapabilityRoutes(app: FastifyInstance, context: TenantContext): void {
  app.post("/internal/agents/authority",{bodyLimit:8192},async request=>{
    await verifyCapabilityService(context,request.headers.authorization,request.body,"product-execution-authority");
    const input=request.body as import("@kasitek-labs/contracts").ProductOriginAuthorization;
    const text=(value:unknown)=>typeof value==="string"&&value.length>0&&value.length<=512;
    if(!input||input.version!=="1"||input.product!=="agencies"||!text(input.requestId)||!text(input.taskId)||!text(input.conversationId)||
      !text(input.tenantId)||!text(input.clientId)||!input.actor||!text(input.actor.issuer)||!text(input.actor.subject)||
      input.purpose!==undefined&&!["execute","configure_model"].includes(input.purpose))throw bad("invalid execution authority request");
    await authorizeAgencyExecution(context,{tenantId:input.tenantId,clientId:input.clientId!,actor:input.actor,purpose:input.purpose,requireClientSetup:true});
    return {authorized:true};
  });
  app.post("/internal/agents/capabilities", { bodyLimit: 65536 }, async request => {
    await verifyCapabilityService(context, request.headers.authorization, request.body);
    const call = capabilityInvocation(request.body);
    const result = await readWorkspaceAgentMetadata(context, call);
    request.log.info({ event: "product.capability.read", product: "agency", origin_product: call.authority.originProduct,
      mapping_ref: call.authority.mappingRef, operation: call.operation, binding_id: call.bindingId,
      task_id: call.taskId, operation_id: call.operationId, request_id: call.requestId, control: call.control }, "Product capability read");
    return result;
  });
}
