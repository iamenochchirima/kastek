import { ModelGateway } from "../model/gateway";
import type { ModelCredentials, ModelMessage, ModelRequest, ModelResponse } from "../model/types";
import { ModelProviderError } from "../model/types";
import { ToolPolicyError, type ToolApproval, type ToolInvocationContext } from "../tools/types";
import { hashToolArguments, ToolRegistry } from "../tools/registry";
import { classifyFailureCode } from "./failures";
import { redactSensitiveValue, redactToolOutput } from "../tools/redaction";
import type { GroundingProvenance } from "./provenance";
import { buildApprovedToolCompletionMessage, buildApprovedToolFailureMessage } from "./approved-tool-completion";
import type { AgentResponse } from "../media/contracts";

export interface AgentLoopLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  maxEstimatedCostUsd?: number;
  maxWallTimeMs: number;
}

export interface AgentLoopEvent {
  type: "loop.started" | "model.completed" | "tool.proposed" | "tool.completed" | "loop.paused" | "loop.completed" | "loop.failed" | "loop.limited";
  iteration: number;
  payload: Record<string, unknown>;
}

export interface AgentLoopInput {
  model: Pick<ModelRequest, "provider" | "model" | "temperature" | "maxTokens">;
  messages: ModelMessage[];
  credentials: ModelCredentials;
  fallbackModels?: Array<{
    model: Pick<ModelRequest, "provider" | "model" | "temperature" | "maxTokens">;
    credentials: ModelCredentials;
  }>;
  gateway: ModelGateway;
  tools: ToolRegistry;
  toolContext: ToolInvocationContext;
  grantedTools: ReadonlySet<string>;
  signal?: AbortSignal;
  limits?: Partial<AgentLoopLimits>;
  onEvent?: (event: AgentLoopEvent) => Promise<void> | void;
  onModelResponse?: (response: ModelResponse, attempt?: { model: AgentLoopInput["model"]; credentials: ModelCredentials }) => Promise<void> | void;
  onModelError?: (error: { code: string; message: string }, attempt?: { model: AgentLoopInput["model"]; credentials: ModelCredentials }) => Promise<void> | void;
  reserveModelCall?: (input: {
    request: ModelRequest;
    credentials: ModelCredentials;
  }) => Promise<ModelCreditReservation | undefined>;
  reserveRunBudget?: (input: {
    request: ModelRequest;
    reservationKey: string;
  }) => Promise<ModelCreditReservation | undefined>;
  consumeRunToolCall?: () => Promise<void>;
  beforeModelCall?: () => Promise<void> | void;
  beforeToolInvoke?: (input: {
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
    approved: boolean;
  }) => Promise<void> | void;
  onToolProposed?: (input: {
    toolCallId: string;
    name: string;
    version: string;
    riskClass: string;
    arguments: Record<string, unknown>;
    argumentsHash: string;
    requiresApproval: boolean;
    sequenceNumber: number;
  }) => Promise<void> | void;
  onToolExecuting?: (input: {
    toolCallId: string;
    name: string;
    version: string;
    arguments: Record<string, unknown>;
    argumentsHash: string;
    requiresApproval: boolean;
  }) => Promise<void> | void;
  onToolCompleted?: (input: {
    toolCallId: string;
    name: string;
    argumentsHash: string;
    output: unknown;
    latencyMs: number;
    effectId?: string;
    approval?: ToolApproval;
  }) => Promise<void> | void;
  onToolFailed?: (input: { toolCallId: string; name: string; argumentsHash?: string; error: { code: string; message: string } }) => Promise<void> | void;
  resumeApprovedToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    approval: ToolApproval;
  };
}

export interface ModelCreditReservation {
  capture(response: ModelResponse): Promise<void>;
  release(reason: string): Promise<void>;
}

export interface AgentLoopResult {
  status: "completed" | "awaiting_approval" | "awaiting_human" | "awaiting_external_event" | "limited" | "failed";
  messages: ModelMessage[];
  response?: ModelResponse;
  completionMessage?: string;
  completionResponse?: AgentResponse;
  pendingToolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown>; argumentsHash: string }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number };
  iterations: number;
  toolCalls: number;
  error?: { code: string; message: string; failureClass?: "retryable" | "terminal"; userMessage?: string };
  waitingFor?: string;
  provenance?: GroundingProvenance;
}

const defaultLimits: AgentLoopLimits = {
  maxIterations: 8,
  maxToolCalls: 16,
  maxTotalTokens: 32_000,
  maxWallTimeMs: 60_000,
};

async function emit(input: AgentLoopInput, event: AgentLoopEvent): Promise<void> {
  await input.onEvent?.(event);
}

export async function runBoundedAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const limits = { ...defaultLimits, ...input.limits };
  const messages = [...input.messages];
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 };
  let toolCalls = 0;
  let lastModelAttempt: { model: AgentLoopInput["model"]; credentials: ModelCredentials } = { model: input.model, credentials: input.credentials };
  const startedAt = Date.now();
  await emit(input, { type: "loop.started", iteration: 0, payload: {} });

  if (input.resumeApprovedToolCall) {
    try {
      const resumed = input.resumeApprovedToolCall;
      const resumedManifest = input.tools.get(resumed.name);
      await input.onToolProposed?.({
        toolCallId: resumed.id,
        name: resumed.name,
        version: resumedManifest?.version ?? "unknown",
        riskClass: resumedManifest?.riskClass ?? "privileged",
        arguments: resumed.arguments,
        argumentsHash: hashToolArguments(resumed.arguments),
        requiresApproval: resumedManifest?.requiresApproval ?? true,
        sequenceNumber: 1,
      });
      await input.beforeToolInvoke?.({
        toolCallId: resumed.id,
        name: resumed.name,
        arguments: resumed.arguments,
        approved: true,
      });
      await input.consumeRunToolCall?.();
      const result = await input.tools.invoke({
        name: resumed.name,
        arguments: resumed.arguments,
        context: input.signal ? { ...input.toolContext, signal: input.signal } : input.toolContext,
        signal: input.signal,
        grantedTools: input.grantedTools,
        approval: resumed.approval,
        beforeEffect: resumedManifest?.riskClass === "external-effect" ? async () => {
          await input.onToolExecuting?.({
            toolCallId: resumed.id,
            name: resumed.name,
            version: resumedManifest.version,
            arguments: resumed.arguments,
            argumentsHash: hashToolArguments(resumed.arguments),
            requiresApproval: resumedManifest.requiresApproval,
          });
        } : undefined,
      });
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: resumed.id, name: resumed.name, arguments: resumed.arguments }] });
      const safeOutput = redactSensitiveValue(result.output);
      const durableOutput = redactToolOutput(result.output, resumedManifest?.manifest?.redaction ?? []);
      messages.push({ role: "tool", name: resumed.name, toolCallId: resumed.id, content: JSON.stringify(safeOutput) });
      toolCalls += 1;
      await input.onToolCompleted?.({ toolCallId: resumed.id, name: resumed.name, argumentsHash: hashToolArguments(resumed.arguments), output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId, approval: resumed.approval });
      await emit(input, { type: "tool.completed", iteration: 0, payload: { name: resumed.name, resumed: true, latencyMs: result.latencyMs } });
      const completionMessage = buildApprovedToolCompletionMessage(resumed.name, resumed.arguments, safeOutput);
      messages.push({ role: "assistant", content: completionMessage });
      await emit(input, { type: "loop.completed", iteration: 0, payload: { toolCalls, totalTokens: usage.totalTokens, resumed: true } });
      return { status: "completed", messages, completionMessage, usage, iterations: 0, toolCalls };
    } catch (error) {
      const normalized = error instanceof ToolPolicyError
        ? { code: error.code, message: error.message, failureClass: classifyFailureCode(error.code) }
        : { code: "APPROVED_TOOL_FAILED", message: error instanceof Error ? error.message : "Approved tool failed", failureClass: "terminal" as const };
      const failure = {
        ...normalized,
        userMessage: buildApprovedToolFailureMessage(input.resumeApprovedToolCall.name, error),
      };
      await emit(input, { type: "loop.failed", iteration: 0, payload: failure });
      await input.onToolFailed?.({ toolCallId: input.resumeApprovedToolCall.id, name: input.resumeApprovedToolCall.name, argumentsHash: hashToolArguments(input.resumeApprovedToolCall.arguments), error: normalized });
      return { status: "failed", messages, usage, iterations: 0, toolCalls, error: failure };
    }
  }

  for (let iteration = 1; iteration <= limits.maxIterations; iteration += 1) {
    if (Date.now() - startedAt >= limits.maxWallTimeMs) {
      await emit(input, { type: "loop.limited", iteration, payload: { reason: "wall_clock" } });
      return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls };
    }
    if (usage.totalTokens >= limits.maxTotalTokens || (limits.maxEstimatedCostUsd !== undefined && usage.estimatedCostUsd >= limits.maxEstimatedCostUsd)) {
      await emit(input, { type: "loop.limited", iteration, payload: { reason: "budget" } });
      return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls };
    }
    const remainingTokens = Math.max(1, limits.maxTotalTokens - usage.totalTokens);
    try {
      const attempts = [
        { model: input.model, credentials: input.credentials },
        ...(input.fallbackModels ?? []),
      ];
      let response: ModelResponse | undefined;
      let lastError: unknown;
      for (const attempt of attempts) {
        lastModelAttempt = attempt;
        let creditReservation: ModelCreditReservation | undefined;
        let runBudgetReservation: ModelCreditReservation | undefined;
        try {
          await input.beforeModelCall?.();
          const request: ModelRequest = {
            ...attempt.model,
            messages,
            signal: input.signal,
            tools: input.tools.list(input.grantedTools),
            maxTokens: attempt.model.maxTokens === undefined ? remainingTokens : Math.min(attempt.model.maxTokens, remainingTokens),
          };
          runBudgetReservation = await input.reserveRunBudget?.({ request, reservationKey: `model:${iteration}:${attempts.indexOf(attempt)}` });
          creditReservation = await input.reserveModelCall?.({ request, credentials: attempt.credentials });
          response = await input.gateway.complete(request, attempt.credentials);
          if (runBudgetReservation) {
            await runBudgetReservation.capture(response);
            runBudgetReservation = undefined;
          }
          if (creditReservation) {
            await creditReservation.capture(response);
            creditReservation = undefined;
          }
          break;
        } catch (error) {
          if (runBudgetReservation) {
            await runBudgetReservation.release(error instanceof Error ? error.message : "model provider failure").catch(() => undefined);
          }
          if (creditReservation) {
            await creditReservation.release(error instanceof Error ? error.message : "model provider failure").catch(() => undefined);
          }
          lastError = error;
          // A fallback is only for provider failures. Budget, policy, and
          // cancellation errors must stop the run immediately.
          if (!(error instanceof ModelProviderError)) throw error;
        }
      }
      if (!response) throw lastError ?? new Error("Model gateway returned no response");
      await input.onModelResponse?.(response, lastModelAttempt);
      messages.push(response.message);
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      usage.totalTokens += response.usage.totalTokens;
      usage.estimatedCostUsd += response.usage.estimatedCostUsd ?? 0;
      await emit(input, {
        type: "model.completed",
        iteration,
        payload: {
          provider: response.provider,
          model: response.model,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          finishReason: response.finishReason,
          toolCallCount: response.toolCalls.length,
        },
      });
      if (response.toolCalls.length === 0) {
        if (!response.message.content.trim()) {
          const error = {
            code: "EMPTY_ASSISTANT_RESPONSE",
            message: "The model returned no assistant text, so the run could not produce a reply",
            failureClass: "terminal" as const,
          };
          await emit(input, { type: "loop.failed", iteration, payload: error });
          return { status: "failed", messages, response, usage, iterations: iteration, toolCalls, error };
        }
        await emit(input, { type: "loop.completed", iteration, payload: { toolCalls, totalTokens: usage.totalTokens } });
        return { status: "completed", messages, response, usage, iterations: iteration, toolCalls };
      }
      for (const toolCall of response.toolCalls) {
        toolCalls += 1;
        if (toolCalls > limits.maxToolCalls) {
          await emit(input, { type: "loop.limited", iteration, payload: { reason: "tool_calls" } });
          return { status: "limited", messages, response, usage, iterations: iteration, toolCalls };
        }
        const argumentsHash = hashToolArguments(toolCall.arguments);
        const manifest = input.tools.get(toolCall.name);
        await emit(input, { type: "tool.proposed", iteration, payload: { name: toolCall.name, argumentsHash } });
        await input.onToolProposed?.({
          toolCallId: toolCall.id,
          name: toolCall.name,
          version: manifest?.version ?? "unknown",
          riskClass: manifest?.riskClass ?? "privileged",
          arguments: toolCall.arguments,
          argumentsHash,
          requiresApproval: manifest?.requiresApproval ?? false,
          sequenceNumber: toolCalls,
        });
        try {
          await input.beforeToolInvoke?.({
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            approved: false,
          });
          await input.consumeRunToolCall?.();
          const result = await input.tools.invoke({
            name: toolCall.name,
            arguments: toolCall.arguments,
            context: input.signal ? { ...input.toolContext, signal: input.signal } : input.toolContext,
            signal: input.signal,
            grantedTools: input.grantedTools,
            beforeEffect: manifest?.riskClass === "external-effect" ? async () => {
              await input.onToolExecuting?.({
                toolCallId: toolCall.id,
                name: toolCall.name,
                version: manifest.version,
                arguments: toolCall.arguments,
                argumentsHash,
                requiresApproval: manifest.requiresApproval,
              });
            } : undefined,
          });
          const safeOutput = redactSensitiveValue(result.output);
          const durableOutput = redactToolOutput(result.output, manifest?.manifest?.redaction ?? []);
          messages.push({
            role: "tool",
            name: toolCall.name,
            toolCallId: toolCall.id,
            content: JSON.stringify(safeOutput),
          });
          await emit(input, { type: "tool.completed", iteration, payload: { name: toolCall.name, latencyMs: result.latencyMs } });
          await input.onToolCompleted?.({ toolCallId: toolCall.id, name: toolCall.name, argumentsHash, output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId });
          if (result.control === "final_response") {
            const completionResponse = (safeOutput as { response: AgentResponse }).response;
            await emit(input, { type: "loop.completed", iteration, payload: { toolCalls, totalTokens: usage.totalTokens, responseFormat: "agent-response.v1" } });
            return { status: "completed", messages, response, completionMessage: completionResponse.text, completionResponse, usage, iterations: iteration, toolCalls };
          }
          if (result.control === "awaiting_human") {
            await emit(input, { type: "loop.paused", iteration, payload: { reason: "handoff", name: toolCall.name } });
            const safeOutputRecord = safeOutput && typeof safeOutput === "object" ? safeOutput as Record<string, unknown> : undefined;
            const handoffRequestId = safeOutputRecord && typeof safeOutputRecord.handoffRequestId === "string"
              ? safeOutputRecord.handoffRequestId
              : undefined;
            return {
              status: "awaiting_human",
              messages,
              response,
              usage,
              iterations: iteration,
              toolCalls,
              waitingFor: handoffRequestId,
            };
          }
        } catch (error) {
          if (error instanceof ToolPolicyError && error.code === "APPROVAL_REQUIRED") {
            await emit(input, { type: "loop.paused", iteration, payload: { reason: "approval", name: toolCall.name } });
            return {
              status: "awaiting_approval",
              messages,
              response,
              pendingToolCalls: [{ ...toolCall, argumentsHash: hashToolArguments(toolCall.arguments) }],
              usage,
              iterations: iteration,
              toolCalls,
            };
          }
          const normalized = error instanceof ToolPolicyError
            ? { code: error.code, message: error.message }
            : { code: "TOOL_FAILED", message: error instanceof Error ? error.message : "Tool failed" };
          await input.onToolFailed?.({ toolCallId: toolCall.id, name: toolCall.name, argumentsHash, error: normalized });
          throw error;
        }
      }
    } catch (error) {
      const normalized = error instanceof ModelProviderError || error instanceof ToolPolicyError
        ? { code: error.code, message: error.message, failureClass: classifyFailureCode(error.code) }
        : { code: "AGENT_LOOP_FAILED", message: error instanceof Error ? error.message : "Unknown agent loop failure", failureClass: "terminal" as const };
      if (error instanceof ModelProviderError) await input.onModelError?.(normalized, lastModelAttempt);
      await emit(input, { type: "loop.failed", iteration, payload: normalized });
      return { status: "failed", messages, usage, iterations: iteration, toolCalls, error: normalized };
    }
  }
  await emit(input, { type: "loop.limited", iteration: limits.maxIterations, payload: { reason: "iterations" } });
  return { status: "limited", messages, usage, iterations: limits.maxIterations, toolCalls };
}
