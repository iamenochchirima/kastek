import { ModelGateway } from "../model/gateway";
import type { ModelCredentials, ModelMessage, ModelRequest, ModelResponse } from "../model/types";
import { ModelProviderError } from "../model/types";
import { ToolPolicyError, type ToolApproval, type ToolInvocationContext } from "../tools/types";
import { hashToolArguments, ToolRegistry } from "../tools/registry";
import { classifyFailureCode } from "./failures";
import { redactSensitiveValue } from "../tools/redaction";

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
  gateway: ModelGateway;
  tools: ToolRegistry;
  toolContext: ToolInvocationContext;
  grantedTools: ReadonlySet<string>;
  limits?: Partial<AgentLoopLimits>;
  onEvent?: (event: AgentLoopEvent) => Promise<void> | void;
  onModelResponse?: (response: ModelResponse) => Promise<void> | void;
  onModelError?: (error: { code: string; message: string }) => Promise<void> | void;
  beforeModelCall?: () => Promise<void> | void;
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
    argumentsHash: string;
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

export interface AgentLoopResult {
  status: "completed" | "awaiting_approval" | "limited" | "failed";
  messages: ModelMessage[];
  response?: ModelResponse;
  pendingToolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown>; argumentsHash: string }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number };
  iterations: number;
  toolCalls: number;
  error?: { code: string; message: string; failureClass?: "retryable" | "terminal" };
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
      if (resumedManifest?.riskClass === "external-effect") {
        await input.onToolExecuting?.({
          toolCallId: resumed.id,
          name: resumed.name,
          argumentsHash: hashToolArguments(resumed.arguments),
        });
      }
      const result = await input.tools.invoke({
        name: resumed.name,
        arguments: resumed.arguments,
        context: input.toolContext,
        grantedTools: input.grantedTools,
        approval: resumed.approval,
      });
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: resumed.id, name: resumed.name, arguments: resumed.arguments }] });
      const safeOutput = redactSensitiveValue(result.output);
      messages.push({ role: "tool", name: resumed.name, toolCallId: resumed.id, content: JSON.stringify(safeOutput) });
      toolCalls += 1;
      await input.onToolCompleted?.({ toolCallId: resumed.id, name: resumed.name, argumentsHash: hashToolArguments(resumed.arguments), output: safeOutput, latencyMs: result.latencyMs, effectId: result.effectId, approval: resumed.approval });
      await emit(input, { type: "tool.completed", iteration: 0, payload: { name: resumed.name, resumed: true, latencyMs: result.latencyMs } });
    } catch (error) {
      const normalized = error instanceof ToolPolicyError
        ? { code: error.code, message: error.message, failureClass: classifyFailureCode(error.code) }
        : { code: "APPROVED_TOOL_FAILED", message: error instanceof Error ? error.message : "Approved tool failed", failureClass: "terminal" as const };
      await emit(input, { type: "loop.failed", iteration: 0, payload: normalized });
      await input.onToolFailed?.({ toolCallId: input.resumeApprovedToolCall.id, name: input.resumeApprovedToolCall.name, argumentsHash: hashToolArguments(input.resumeApprovedToolCall.arguments), error: normalized });
      return { status: "failed", messages, usage, iterations: 0, toolCalls, error: normalized };
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
      await input.beforeModelCall?.();
      const response = await input.gateway.complete({
        ...input.model,
        messages,
        tools: input.tools.list(input.grantedTools),
        maxTokens: input.model.maxTokens === undefined ? remainingTokens : Math.min(input.model.maxTokens, remainingTokens),
      }, input.credentials);
      await input.onModelResponse?.(response);
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
          if (manifest?.riskClass === "external-effect" && !manifest.requiresApproval) {
            await input.onToolExecuting?.({ toolCallId: toolCall.id, name: toolCall.name, argumentsHash });
          }
          const result = await input.tools.invoke({
            name: toolCall.name,
            arguments: toolCall.arguments,
            context: input.toolContext,
            grantedTools: input.grantedTools,
          });
          const safeOutput = redactSensitiveValue(result.output);
          messages.push({
            role: "tool",
            name: toolCall.name,
            toolCallId: toolCall.id,
            content: JSON.stringify(safeOutput),
          });
          await emit(input, { type: "tool.completed", iteration, payload: { name: toolCall.name, latencyMs: result.latencyMs } });
          await input.onToolCompleted?.({ toolCallId: toolCall.id, name: toolCall.name, argumentsHash, output: safeOutput, latencyMs: result.latencyMs, effectId: result.effectId });
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
      if (error instanceof ModelProviderError) await input.onModelError?.(normalized);
      await emit(input, { type: "loop.failed", iteration, payload: normalized });
      return { status: "failed", messages, usage, iterations: iteration, toolCalls, error: normalized };
    }
  }
  await emit(input, { type: "loop.limited", iteration: limits.maxIterations, payload: { reason: "iterations" } });
  return { status: "limited", messages, usage, iterations: limits.maxIterations, toolCalls };
}
