import { z } from "zod";
import type { HarnessMessage, ToolDefinition } from "./model-messages";
import type { ModelProtocol } from "./model-providers";
export type ProviderProtocol = ModelProtocol;
export interface PrivateNativeState {
  provider: string; protocol: ProviderProtocol; model: string; baseUrl: string; credentialRevision: string;
  assistant: unknown;
}
export interface ProviderTransportRequest {
  provider: string; protocol: ProviderProtocol; model: string; baseUrl: string; credentialRevision: string;
  contextWindowTokens: number; maxOutputTokens: number; messages: HarnessMessage[]; tools?: ToolDefinition[];
  /** Native protocol options, supplied only by the trusted policy resolver. */
  reasoning?: Record<string, unknown>; reasoningCapable?: boolean;
  nativeHistory?: Record<number, PrivateNativeState>;
  maxRequestBytes?: number; maxResponseBytes?: number;
}
export interface ProviderTransportOptions {
  apiKey: string; signal?: AbortSignal; fetch?: typeof fetch; onText?: (delta: string) => void;
  onProgress?: () => void;
  preparePayload?: (payload: Record<string, unknown>) => void;
  beforePayloadDispatch?: (payload: Readonly<Record<string, unknown>>) => Promise<void>;
}
const identityModelId = z.string().min(1).max(512).refine(value=>value.trim()===value && !/[\u0000-\u001f\u007f]/.test(value));
export const modelIdentitySchema = z.strictObject({
  requestedModelId: identityModelId,
  returnedModelId: identityModelId.nullable(),
  relation: z.enum(["same", "different", "unreported"]),
}).superRefine((identity, context) => {
  const relation = identity.returnedModelId === null ? "unreported" : identity.requestedModelId === identity.returnedModelId ? "same" : "different";
  if (identity.relation !== relation) context.addIssue({code:"custom",path:["relation"],message:"Returned model relation disagrees with reported identity"});
});
export type ModelIdentity = z.infer<typeof modelIdentitySchema>;
export interface ProviderTransportResponse {
  message: HarnessMessage; finishReason: "stop" | "tool_calls" | "length" | "refusal";
  usage: { observed: boolean; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number;
    cacheWriteTokens?: number; reasoningTokens?: number };
  modelIdentity?: ModelIdentity;
  providerRequestId?: string; nativeState: PrivateNativeState;
}
export const modelStreamErrorKindSchema=z.enum(["upstream_sse_error","malformed_sse_json","unclassified"]);
export const modelFailureDiagnosticsSchema=z.strictObject({
  httpStatus:z.number().int().min(100).max(599).optional(),
  stage:z.enum(["request","response_body","provider_stream","response_validation"]),dispatched:z.boolean(),
  streamErrorKind:modelStreamErrorKindSchema.optional(),providerErrorCode:z.number().int().min(100).max(599).optional(),
});
export type ModelFailureDiagnostics=z.infer<typeof modelFailureDiagnosticsSchema>;
export class ProviderTransportError extends Error {
  constructor(readonly code: string, readonly outcome: "rejected" | "uncertain", readonly status = 502,readonly diagnostics?:ModelFailureDiagnostics) {
    super(code); this.name = "ProviderTransportError";
  }
}

