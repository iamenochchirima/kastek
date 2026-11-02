import type { ProductCapabilityDescriptor } from "@kasitek-labs/contracts";
import { growthOperations } from "./catalog.js";
import { growthToolInputSchema } from "./transport.js";

/** MCP and embedded tools use these exact names and schemas; only the transport envelope differs. */
export const growthOperationDescriptors: ProductCapabilityDescriptor[] = growthOperations.map(operation => ({
  operation: operation.name, revision: operation.version, description: operation.description,
  inputSchema: growthToolInputSchema(operation), outputSchema: operation.outputSchema,
  handlerRef: `growth.operation.${operation.name}@${operation.version}`,
  policy: operation.effect === "draft" && operation.review === "none"
    ? { effect: "draft_write", disclosure: "exact_requested_payload", retry: "status_only", approval: "none", cancel: "reconcile_claimed" }
    : operation.review === "required"
    ? { effect: "reviewed_write", disclosure: "exact_reviewed_payload", retry: "status_only", approval: "exact_single_use", cancel: "reconcile_claimed" }
    : { effect: "read", disclosure: "approved_resource_identifiers", retry: "safe_read", approval: "none", cancel: "stop_admission" },
  requiredAuthority: ["feature.agents.manage", ...operation.requiredEntitlements], evidence: "none",
  limits: { timeoutMs: 30000, maxPhysicalAttempts: 1, maxResponseBytes: 262144, maxModelResultBytes: 8192 },
}));
