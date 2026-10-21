import { api, ApiError, organizationPath } from "./api";

export type ModelProvider = { id: string; name: string; baseUrl: string; officialDocsUrl: string; adapter: { readiness: "installed" | "planned" } };
export type ModelProviderConnection = { id: string; providerId: string; name: string; endpoint: string; revision: number; credentialRevision: number; state: "active" | "revoked" | "removed"; verification: "saved" | "discovered" | "inference_verified" | "tools_verified" };
type Capability = { value: boolean | null; evidence: "unknown" | "declared" | "discovered" | "verified" };
export type ProviderModel = { id: string; name: string; contextTokens: { value: number | null }; maxOutputTokens: { value: number | null }; capabilities: { tools: Capability; reasoning: Capability; structuredOutput: Capability }; lifecycle: "active" | "deprecated" | "retired" | "unknown"; pricing: { inputMicrosPerMillionTokens: number | null; outputMicrosPerMillionTokens: number | null } | null };
export type ProviderModels = { kind: "discovered"; models: ProviderModel[]; observedAt: string; visibility: "public_catalog" | "credential_scoped"; complete: boolean } | { kind: "manual_required"; models: []; observedAt: string };
export type CachedProviderModels = { result: ProviderModels | null; stale: boolean; fetchedAt: string | null; connectionRevision: number; credentialRevision: number };
export type DefaultModel = { selection: { kind: "connection"; connectionId: string; modelId: string } | null; revision: number };
export type ModelProbe = { verification: "inference_verified" | "tools_verified"; modelId: string; usage: { observed: boolean; inputTokens?: number; outputTokens?: number } };
export const modelProviderPath = (organizationId: string) => `${organizationPath(organizationId)}/model-providers`;
export const providerApi = <T>(organizationId: string, suffix = "", body?: unknown, method?: string) => api<T>(`${modelProviderPath(organizationId)}${suffix}`, body, method);
export function providerError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Workspace owner access required.";
    if (error.status === 409) return "Connection changed. Reload and try again.";
    if (error.status === 429) return "Too many requests. Try again shortly.";
    if (error.status === 400) return "Check the connection details and try again.";
    if (error.status === 503) return "Provider setup is unavailable. Try again later.";
  }
  return "Request failed. Try again.";
}
