import type { CapabilityBinding } from "../contracts/capability-catalog";
import { readableToolTitle, type ToolCatalogMetadata } from "./tool-discovery";
import { connectedModelTool } from "./connected-tools/connected-tool-schema";

/** Presentation comes from the same accepted binding as execution, never a second tool registry. */
export function capabilityBindingPresentation(binding: CapabilityBinding): Pick<ToolCatalogMetadata,
  "title" | "category" | "purpose" | "effect" | "source" | "readiness" | "schemaLoading"> {
  const product = Boolean(binding.authority);
  const externalMetadata = !product && ["remote-mcp-v1", "custom-api-v1", "hubspot-contacts-v1"].includes(binding.connection?.profileId ?? "");
  const operation = binding.definition.providerOperation;
  const segments = operation.split(".");
  const action = segments.at(-1) ?? operation;
  const verb = ({ get: "Read", list: "Find", search: "Find" } as Record<string, string>)[action] ?? readableToolTitle(action);
  const resource = segments.length > 1 ? segments.at(-2)!.replace(/_/g, " ") : "";
  return {
    title: `${verb}${resource ? ` ${resource}` : ""}`.slice(0, 120),
    category: product ? readableToolTitle(operation.split(".")[0] || "Business") : externalMetadata ? "Connected services" : readableToolTitle((binding.connection?.profileId ?? "Connected services").replace(/-v\d+$/, "")),
    purpose: (product || externalMetadata ? binding.definition.description : connectedModelTool(binding).function.description).slice(0, 512),
    effect: binding.policy.effect,
    source: product ? "product" : externalMetadata ? "connection" : "adapter",
    readiness: "available",
    schemaLoading: externalMetadata ? "deferred" : "auto",
  };
}
