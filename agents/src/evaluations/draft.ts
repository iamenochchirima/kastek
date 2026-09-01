import type { AgentVersionRecord } from "../db/repositories/agent-repository";
import { resolveModelTarget } from "../model/policy";
import type { CredentialResolver } from "../model/credentials";
import type { ModelGateway } from "../model/gateway";
import type { ModelRequest, ModelResponse } from "../model/types";
import { withSpan } from "../telemetry/spans";
import { validateWorkflowGraph } from "../workflows/graph";

export const DRAFT_EVALUATION_TIMEOUT_MS = 30_000;
export const DRAFT_EVALUATION_MAX_TOKENS = 4_096;
export const DRAFT_EVALUATION_MAX_PROMPT_CHARS = 64_000;
export const DRAFT_EVALUATION_MAX_OUTPUT_CHARS = 100_000;

export interface DraftEvaluationOutput {
  actualOutput: {
    text: string;
  };
  model: {
    provider: ModelResponse["provider"];
    model: string;
  };
  usage: ModelResponse["usage"];
  isolation: {
    executionMode: "draft";
    liveRunId: null;
    toolCalls: 0;
    memoryReads: 0;
    memoryWrites: 0;
    deliveryAttempts: 0;
  };
}

export interface DraftEvaluationDependencies {
  gateway: Pick<ModelGateway, "complete">;
  credentials: CredentialResolver;
}

export interface DraftEvaluationInput {
  organizationId: string;
  version: AgentVersionRecord;
  scenarioInput: Record<string, unknown>;
}

export type DraftEvaluationRunner = (input: DraftEvaluationInput) => Promise<DraftEvaluationOutput>;

function scenarioPrompt(input: Record<string, unknown>): string {
  const preferred = [input.message, input.prompt, input.input].find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const prompt = preferred ?? JSON.stringify(input);
  if (prompt.length > DRAFT_EVALUATION_MAX_PROMPT_CHARS) throw new Error("DRAFT_INPUT_TOO_LARGE");
  return prompt;
}

function boundedMaxTokens(configuration: Record<string, unknown>, targetMaxTokens?: number): number {
  const configured = typeof configuration.maxTokens === "number" && Number.isFinite(configuration.maxTokens)
    ? Math.floor(configuration.maxTokens)
    : targetMaxTokens;
  return Math.max(1, Math.min(DRAFT_EVALUATION_MAX_TOKENS, configured ?? DRAFT_EVALUATION_MAX_TOKENS));
}

function configuredTemperature(configuration: Record<string, unknown>): number | undefined {
  const value = configuration.temperature;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : undefined;
}

/**
 * Execute one candidate version as a pure model call. This deliberately does
 * not create an agent run, load memory or knowledge, register tools, invoke
 * connectors, or deliver to a channel. The caller persists only the returned
 * evaluation evidence.
 */
export async function executeDraftEvaluation(
  input: DraftEvaluationInput,
  dependencies: DraftEvaluationDependencies,
): Promise<DraftEvaluationOutput> {
  if (input.version.status === "retired") throw new Error("DRAFT_VERSION_RETIRED");
  if (input.version.configuration.workflow !== undefined) {
    try {
      validateWorkflowGraph(input.version.configuration.workflow);
    } catch {
      throw new Error("DRAFT_WORKFLOW_INVALID");
    }
  }
  const target = resolveModelTarget(input.version.configuration, input.version.policy);
  const credentialReference = typeof input.version.configuration.credentialReference === "string"
    ? input.version.configuration.credentialReference
    : target.credentialReference;
  const credentials = await dependencies.credentials.resolve(target.provider, credentialReference, input.organizationId);
  const request: ModelRequest = {
    provider: target.provider,
    model: target.model,
    messages: [
      { role: "system", content: input.version.instructions },
      { role: "user", content: scenarioPrompt(input.scenarioInput) },
    ],
    temperature: configuredTemperature(input.version.configuration),
    maxTokens: boundedMaxTokens(input.version.configuration, target.maxTokensPerRun),
    timeoutMs: DRAFT_EVALUATION_TIMEOUT_MS,
    maxAttempts: 1,
  };
  const response = await withSpan("evaluation.draft", {
    "kasitek.evaluation.mode": "draft",
    "kasitek.model.provider": target.provider,
  }, () => dependencies.gateway.complete(request, credentials));
  if (response.toolCalls.length > 0 || response.message.toolCalls?.length) throw new Error("DRAFT_TOOL_CALL_UNSUPPORTED");
  if (response.message.content.length > DRAFT_EVALUATION_MAX_OUTPUT_CHARS) throw new Error("DRAFT_OUTPUT_TOO_LARGE");
  return {
    actualOutput: { text: response.message.content },
    model: { provider: response.provider, model: response.model },
    usage: response.usage,
    isolation: {
      executionMode: "draft",
      liveRunId: null,
      toolCalls: 0,
      memoryReads: 0,
      memoryWrites: 0,
      deliveryAttempts: 0,
    },
  };
}
