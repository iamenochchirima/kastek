import { z } from "zod";
import { acceptedModelRoutesSchema } from "./model-bindings";
import { executionGrantSchema } from "./contracts";

/** Contract for a future Lina lifecycle adapter. The current runtime availability check rejects workspace execution. */
export const workspaceExecutionRequestSchema = z.strictObject({
  taskId: z.uuid(),
  runtime: z.literal("lina"),
  grant: executionGrantSchema,
  models: acceptedModelRoutesSchema,
}).superRefine((request, context) => {
  if (Object.values(request.models).some(route => route.binding.organizationId !== request.grant.organizationId ||
      (request.grant.rootTokenLimit !== null && (route.policy.maxRootTokens === null || route.policy.maxRootTokens > request.grant.rootTokenLimit)) || route.policy.maxInputBytes > request.grant.maxInputBytes ||
      route.policy.maxInputTokens > request.grant.maxContextTokens || route.policy.maxOutputTokens > request.grant.maxOutputTokens)) {
    context.addIssue({ code: "custom", message: "Workspace model policy exceeds its execution grant" });
  }
});
export type WorkspaceExecutionRequest = z.infer<typeof workspaceExecutionRequestSchema>;
