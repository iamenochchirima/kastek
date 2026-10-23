import type { FastifyInstance } from "fastify";
import type { TenantContext } from "../context.js";
import { capabilityInvocation, verifyCapabilityService } from "../capabilities/authority.js";
import { readWorkspaceAgentMetadata } from "../capabilities/workspace-agent-metadata.js";
export function registerProductCapabilityRoutes(app: FastifyInstance, context: TenantContext): void {
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
