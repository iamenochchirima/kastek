import { z } from "zod";
import { effectiveExecutionPolicySchema, modelDescriptorSchema, providerDefinitionSchema,
  providerUseGrantSchema, resolvedModelBindingSchema } from "./model-providers";

export const acceptedModelRouteSchema = z.strictObject({
  binding: resolvedModelBindingSchema,
  definition: providerDefinitionSchema,
  model: modelDescriptorSchema,
  policy: effectiveExecutionPolicySchema,
  consumer: providerUseGrantSchema.shape.consumer,
}).superRefine((route, context) => {
  if (route.binding.providerId !== route.definition.id || route.binding.protocol !== route.definition.protocol ||
      route.binding.modelId !== route.model.id || route.binding.modelRevision !== route.model.revision ||
      route.binding.providerId !== route.model.providerId || route.binding.protocol !== route.model.protocol ||
      route.binding.policyDigest !== route.policy.digest || route.binding.adapterId !== route.definition.adapter.id ||
      route.binding.adapterRevision !== route.definition.adapter.revision) {
    context.addIssue({ code: "custom", message: "Accepted model route fields disagree" });
  }
});
export type AcceptedModelRoute = z.infer<typeof acceptedModelRouteSchema>;

export const acceptedModelRoutesSchema = z.strictObject({
  primary: acceptedModelRouteSchema,
  compaction: acceptedModelRouteSchema,
  delegated: acceptedModelRouteSchema,
}).superRefine((routes, context) => {
  for (const role of ["primary", "compaction", "delegated"] as const) {
    if (routes[role].binding.role !== role && !(role === "primary" && routes[role].binding.role === "delegated")) context.addIssue({ code: "custom", message: "Model role disagrees with route", path: [role] });
    if (routes[role].binding.organizationId !== routes.primary.binding.organizationId) {
      context.addIssue({ code: "custom", message: "Model roles must belong to one organization", path: [role] });
    }
  }
});
export type AcceptedModelRoutes = z.infer<typeof acceptedModelRoutesSchema>;
