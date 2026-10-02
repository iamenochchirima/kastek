import type { AgentLoopResult } from "./loop";
import { modelProviderDefinition } from "../model/providers";
import type { ModelCredentialMissingError } from "../model/credentials";

export function modelCredentialFailureResult(error: ModelCredentialMissingError): AgentLoopResult {
  const provider = modelProviderDefinition(error.provider);
  return {
    status: "failed",
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
    iterations: 0,
    toolCalls: 0,
    error: {
      code: error.code,
      message: error.message,
      failureClass: "terminal",
      userMessage: `${provider.label} is not configured for this Agents runtime. Add ${provider.apiKeyEnv} to its local backend environment, then try again.`,
      remediation: `Set ${provider.apiKeyEnv} for both the Agents API and Temporal worker, then restart both processes.`,
    },
  };
}
