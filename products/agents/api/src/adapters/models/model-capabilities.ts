import type { ModelDescriptor } from "../../contracts/model-providers";

export type ModelToolSupport = "supported" | "needs_verification" | "unsupported";
/** The picker and admission share this rule; a successful probe cannot override explicit lack of support. */
export function modelToolSupport(model: ModelDescriptor, verification?: string): ModelToolSupport {
  const tools = model.capabilities.tools;
  if (tools.value === false) return "unsupported";
  if (verification === "tools_verified") return "supported";
  if (tools.value === true && !(tools.source?.kind === "operator" && tools.evidence !== "verified")) return "supported";
  return "needs_verification";
}
