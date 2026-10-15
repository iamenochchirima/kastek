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
      userMessage: `${provider.label} is not configured for this agent. Add a ${provider.label} API key in Models settings or configure ${provider.apiKeyEnv} locally. Keys from different providers are not interchangeable.`,
      remediation: `Use a ${provider.label} key for this model. For locally managed credentials, set ${provider.apiKeyEnv} for the Agents API and Temporal worker, then restart both processes.`,
    },
  };
}
