import { ModelGateway } from "../model/gateway";
import type { ModelCredentials, ModelMessage, ModelRequest, ModelResponse } from "../model/types";
import { ModelProviderError } from "../model/types";
import { estimatePromptTokens } from "../model/credit-pricing";
import { approvalSnapshotHashFromResource, ToolPolicyError, type CapabilityPresentationMetadata, type ToolApproval, type ToolDefinition, type ToolInvocationContext, type ToolInvocationResult } from "../tools/types";
import { hashToolArguments } from "../tools/registry";
import type { AgentHarnessRunStatus, AgentToolSurface } from "./harness";
import { classifyFailureCode } from "./failures";
import { redactSensitiveValue, redactToolOutput } from "../tools/redaction";
import type { GroundingProvenance } from "./provenance";
import { buildApprovedToolCompletionMessage, buildApprovedToolFailureMessage } from "./approved-tool-completion";
import { agentResponseSchema, findAuthorizationRequirement, type AgentAuthorizationRequirement, type AgentResponse } from "../media/contracts";
import { projectCapabilityResultUi } from "../media/dynamic-ui";

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
  tools: AgentToolSurface;
  toolContext: ToolInvocationContext;
  grantedTools: ReadonlySet<string>;
  /** Model-facing capability projection selected by ContextPolicy for this turn. */
  modelTools?: Array<Omit<ToolDefinition, "handler">>;
  signal?: AbortSignal;
  /** Prefix used to keep durable operation keys unique across hosted loop contexts. */
  operationKeyPrefix?: string;
  /** Durable fan-out admission lease used by the first model/tool operation in a branch. */
  parallelLeaseId?: string;
  limits?: Partial<AgentLoopLimits>;
  onEvent?: (event: AgentLoopEvent) => Promise<void> | void;
  /** Claims the operation before a provider call and prevents unsafe replay after worker loss. */
  prepareModelCall?: (input: {
    operationKey: string;
    model: AgentLoopInput["model"];
    credentials: ModelCredentials;
  }) => Promise<{ status: "new" | "completed" | "unknown"; response?: ModelResponse }>;
  /** Persists a provider response before budget settlement and later loop bookkeeping. */
  persistModelResponse?: (input: {
    operationKey: string;
    response: ModelResponse;
    attempt: { model: AgentLoopInput["model"]; credentials: ModelCredentials };
  }) => Promise<void> | void;
  onModelResponse?: (response: ModelResponse, attempt?: { model: AgentLoopInput["model"]; credentials: ModelCredentials }, operationKey?: string) => Promise<void> | void;
  persistModelError?: (input: {
    operationKey: string;
    model: AgentLoopInput["model"];
    credentials: ModelCredentials;
    error: { code: string; message: string };
  }) => Promise<void> | void;
  onModelError?: (error: { code: string; message: string }, attempt?: { model: AgentLoopInput["model"]; credentials: ModelCredentials }, operationKey?: string) => Promise<void> | void;
  reserveModelCall?: (input: {
    request: ModelRequest;
    credentials: ModelCredentials;
    operationKey?: string;
  }) => Promise<ModelCreditReservation | undefined>;
  reserveRunBudget?: (input: {
    request: ModelRequest;
    reservationKey: string;
    parallelLeaseId?: string;
  }) => Promise<ModelCreditReservation | undefined>;
  consumeRunToolCall?: (input?: { parallelLeaseId?: string }) => Promise<void>;
  /** Replays a completed tool outcome after a worker retry without invoking the handler again. */
  replayToolInvocation?: (input: {
    toolCallId: string;
    name: string;
    argumentsHash: string;
  }) => Promise<ToolInvocationResult | undefined>;
  /** Rehydrates the last server-owned view while a stepped loop continues from a checkpoint. */
  resumeUi?: AgentResponse["ui"];
  /** Selects a registered presentation channel; unsupported channels retain text fallback only. */
  uiChannel?: CapabilityPresentationMetadata["channels"][number];
  /** Allows a scoped rollout to disable rich projections without changing response text. */
  dynamicUiEnabled?: boolean;
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
  markUnknown?(reason: string): Promise<void>;
}

export interface AgentLoopResult {
  status: AgentHarnessRunStatus;
  messages: ModelMessage[];
  response?: ModelResponse;
  completionMessage?: string;
  completionResponse?: AgentResponse;
  /** Set when an approved batch was admitted but Core still reports PROCESSING. */
  pendingBatch?: {
    toolName: "kasitek.core.content_post_publish_batch" | "kasitek.core.content_post_publish_batch_retry";
    batchId: string;
    title?: string;
  };
  pendingToolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown>; argumentsHash: string }>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number };
  iterations: number;
  toolCalls: number;
  error?: { code: string; message: string; failureClass?: "retryable" | "terminal"; userMessage?: string };
  waitingFor?: string;
  ui?: AgentResponse["ui"];
  provenance?: GroundingProvenance;
}

function pendingBatchFromOutput(
  toolName: string,
  outputValue: unknown,
): AgentLoopResult["pendingBatch"] {
  if (toolName !== "kasitek.core.content_post_publish_batch" && toolName !== "kasitek.core.content_post_publish_batch_retry") return undefined;
  if (!outputValue || typeof outputValue !== "object" || Array.isArray(outputValue)) return undefined;
  const output = outputValue as Record<string, unknown>;
  const batch = output.batch;
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) return undefined;
  const batchRecord = batch as Record<string, unknown>;
  if (String(batchRecord.status ?? "").toUpperCase() !== "PROCESSING") return undefined;
  const batchId = typeof batchRecord.batchId === "string" ? batchRecord.batchId.trim() : "";
  if (!batchId) return undefined;
  const post = output.post;
  const title = post && typeof post === "object" && !Array.isArray(post) && typeof (post as Record<string, unknown>).title === "string"
    ? ((post as Record<string, unknown>).title as string).trim().slice(0, 240)
    : undefined;
  return {
    toolName: toolName as "kasitek.core.content_post_publish_batch" | "kasitek.core.content_post_publish_batch_retry",
    batchId,
    ...(title ? { title } : {}),
  };
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
  let authorizationRequired: AgentAuthorizationRequirement | undefined;
  let lastToolUi: AgentResponse["ui"] | undefined = input.dynamicUiEnabled === false ? undefined : input.resumeUi;
  let lastModelAttempt: { model: AgentLoopInput["model"]; credentials: ModelCredentials } = { model: input.model, credentials: input.credentials };
  let lastModelOperationKey: string | undefined;
  const startedAt = Date.now();
  await emit(input, { type: "loop.started", iteration: 0, payload: {} });

  if (input.resumeApprovedToolCall) {
    try {
      const resumed = input.resumeApprovedToolCall;
      const resumedManifest = input.tools.get(resumed.name);
      await input.beforeToolInvoke?.({
        toolCallId: resumed.id,
        name: resumed.name,
        arguments: resumed.arguments,
        approved: true,
      });
      const resumedArgumentsHash = hashToolArguments(resumed.arguments);
      const replayed = await input.replayToolInvocation?.({ toolCallId: resumed.id, name: resumed.name, argumentsHash: resumedArgumentsHash });
      if (replayed && (replayed.name !== resumed.name || replayed.argumentsHash !== resumedArgumentsHash)) {
        throw new ToolPolicyError("TOOL_REPLAY_SCOPE_CONFLICT", "A durable tool outcome did not match the approved tool call");
      }
      if (!replayed) await input.onToolProposed?.({
        toolCallId: resumed.id,
        name: resumed.name,
        version: resumedManifest?.version ?? "unknown",
        riskClass: resumedManifest?.riskClass ?? "privileged",
        arguments: resumed.arguments,
        argumentsHash: resumedArgumentsHash,
        requiresApproval: resumedManifest?.requiresApproval ?? true,
        sequenceNumber: 1,
      });
      if (!replayed) await input.consumeRunToolCall?.({ parallelLeaseId: input.parallelLeaseId });
      const result = replayed ?? await input.tools.invoke({
          name: resumed.name,
          arguments: resumed.arguments,
          context: {
            ...input.toolContext,
            ...(resumed.approval.resourceSnapshot && typeof resumed.approval.resourceSnapshot === "object"
              ? { approvalSnapshotHash: approvalSnapshotHashFromResource(resumed.approval.resourceSnapshot) }
              : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          },
          signal: input.signal,
          grantedTools: input.grantedTools,
          approval: resumed.approval,
          beforeEffect: resumedManifest?.riskClass === "external-effect" ? async () => {
            await input.onToolExecuting?.({
              toolCallId: resumed.id,
              name: resumed.name,
              version: resumedManifest.version,
              arguments: resumed.arguments,
              argumentsHash: resumedArgumentsHash,
              requiresApproval: resumedManifest.requiresApproval,
            });
          } : undefined,
        });
      messages.push({ role: "assistant", content: "", toolCalls: [{ id: resumed.id, name: resumed.name, arguments: resumed.arguments }] });
      const authorization = findAuthorizationRequirement(result.output);
      const safeOutput = redactSensitiveValue(result.output);
      const pendingBatch = pendingBatchFromOutput(resumed.name, safeOutput);
      const durableOutput = redactToolOutput(result.output, resumedManifest?.manifest?.redaction ?? []);
      const resumedUi = input.dynamicUiEnabled === false ? undefined : projectCapabilityResultUi({ presentation: resumedManifest?.manifest?.presentation, output: durableOutput, channel: input.uiChannel ?? "platform" });
      if (resumedUi || resumedManifest?.manifest?.presentation) lastToolUi = resumedUi;
      authorizationRequired = authorization;
      messages.push({ role: "tool", name: resumed.name, toolCallId: resumed.id, content: JSON.stringify(safeOutput) });
      toolCalls += 1;
      if (!replayed) await input.onToolCompleted?.({ toolCallId: resumed.id, name: resumed.name, argumentsHash: resumedArgumentsHash, output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId, approval: resumed.approval });
      await emit(input, {
        type: "tool.completed",
        iteration: 0,
        payload: {
          name: resumed.name,
          resumed: true,
          latencyMs: result.latencyMs,
          ...(authorizationRequired ? { authorizationRequired } : {}),
        },
      });
      const completionMessage = buildApprovedToolCompletionMessage(resumed.name, resumed.arguments, safeOutput);
      messages.push({ role: "assistant", content: completionMessage });
      await emit(input, { type: "loop.completed", iteration: 0, payload: { toolCalls, totalTokens: usage.totalTokens, resumed: true } });
      return {
        status: "completed",
        messages,
        completionMessage,
        ...(pendingBatch ? { pendingBatch } : {}),
        ...(authorizationRequired || lastToolUi
          ? { completionResponse: { version: "1" as const, text: completionMessage, media: [], ...(authorizationRequired ? { authorizationRequired } : {}), ...(lastToolUi ? { ui: lastToolUi } : {}) } }
          : {}),
        usage,
        iterations: 0,
        toolCalls,
      };
    } catch (error) {
      const normalized = error instanceof ToolPolicyError
        ? { code: error.code, message: error.message, failureClass: classifyFailureCode(error.code) }
        : { code: "APPROVED_TOOL_FAILED", message: error instanceof Error ? error.message : "Approved tool failed", failureClass: "terminal" as const };
      const failure = {
        ...normalized,
        userMessage: buildApprovedToolFailureMessage(input.resumeApprovedToolCall.name, error, input.resumeApprovedToolCall.arguments),
      };
      await emit(input, { type: "loop.failed", iteration: 0, payload: failure });
      await input.onToolFailed?.({ toolCallId: input.resumeApprovedToolCall.id, name: input.resumeApprovedToolCall.name, argumentsHash: hashToolArguments(input.resumeApprovedToolCall.arguments), error: normalized });
      return { status: "failed", messages, usage, iterations: 0, toolCalls, error: failure };
    }
  }

  for (let iteration = 1; iteration <= limits.maxIterations; iteration += 1) {
    if (Date.now() - startedAt >= limits.maxWallTimeMs) {
      await emit(input, { type: "loop.limited", iteration, payload: { reason: "wall_clock" } });
      return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
    }
    if (usage.totalTokens >= limits.maxTotalTokens || (limits.maxEstimatedCostUsd !== undefined && usage.estimatedCostUsd >= limits.maxEstimatedCostUsd)) {
      await emit(input, { type: "loop.limited", iteration, payload: { reason: "budget" } });
      return { status: "limited", messages, usage, iterations: iteration - 1, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
    }
    const remainingTokens = Math.max(1, limits.maxTotalTokens - usage.totalTokens);
    try {
      const attempts = [
        { model: input.model, credentials: input.credentials },
        ...(input.fallbackModels ?? []),
      ];
      let response: ModelResponse | undefined;
      let lastError: unknown;
      for (const [attemptIndex, attempt] of attempts.entries()) {
        lastModelAttempt = attempt;
        let creditReservation: ModelCreditReservation | undefined;
        let runBudgetReservation: ModelCreditReservation | undefined;
        let operationKey: string | undefined;
        try {
          await input.beforeModelCall?.();
          const tools = input.modelTools ?? input.tools.list(input.grantedTools);
          const estimatedInputTokens = estimatePromptTokens({ messages, tools });
          const availableOutputTokens = Math.max(1, remainingTokens - estimatedInputTokens);
          operationKey = `${input.operationKeyPrefix ?? "model"}:${iteration}:${attemptIndex}`;
          lastModelOperationKey = operationKey;
          const request: ModelRequest = {
            ...attempt.model,
            messages,
            signal: input.signal,
            tools,
            maxTokens: attempt.model.maxTokens === undefined ? availableOutputTokens : Math.min(attempt.model.maxTokens, availableOutputTokens),
          };
          const prepared = await input.prepareModelCall?.({ operationKey, model: attempt.model, credentials: attempt.credentials });
          try {
            runBudgetReservation = await input.reserveRunBudget?.({ request, reservationKey: operationKey, parallelLeaseId: input.parallelLeaseId });
          } catch (error) {
            // The provider response may already be durable while the worker
            // was lost after run-budget settlement. Replay the remaining
            // settlement path instead of failing the run or calling the
            // provider again.
            if (!(prepared?.status === "completed" && error instanceof Error && error.message === "MODEL_CALL_ALREADY_SETTLED")) throw error;
          }
          if (prepared?.status === "unknown") {
            await runBudgetReservation?.markUnknown?.("The worker lost the model operation before its provider outcome was recorded");
            runBudgetReservation = undefined;
            throw new Error("MODEL_CALL_OUTCOME_UNKNOWN");
          }
          if (prepared?.status === "completed") {
            response = prepared.response;
            if (!response) throw new Error("MODEL_CALL_RESPONSE_MISSING");
            // Core credit reservations use the same stable operation key, so
            // replay the same settlement path when the worker died between
            // response persistence and credit capture.
            creditReservation = await input.reserveModelCall?.({ request, credentials: attempt.credentials, operationKey });
          } else {
            creditReservation = await input.reserveModelCall?.({ request, credentials: attempt.credentials, operationKey });
            response = await input.gateway.complete(request, attempt.credentials);
            await input.persistModelResponse?.({ operationKey, response, attempt });
          }
          if (runBudgetReservation) {
            try {
              await runBudgetReservation.capture(response);
            } catch (error) {
              // The response is already durable. A retry may arrive after the
              // budget settlement, in which case it must replay without a
              // second capture.
              if (!(prepared?.status === "completed" && error instanceof Error && error.message === "MODEL_CALL_ALREADY_SETTLED")) throw error;
            }
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
          if (error instanceof ModelProviderError) {
            const normalized = { code: error.code, message: error.message };
            if (operationKey) await input.persistModelError?.({ operationKey, model: attempt.model, credentials: attempt.credentials, error: normalized });
          }
          // A fallback is only for provider failures. Budget, policy, and
          // cancellation errors must stop the run immediately.
          if (!(error instanceof ModelProviderError)) throw error;
        }
      }
      if (!response) throw lastError ?? new Error("Model gateway returned no response");
      await input.onModelResponse?.(response, lastModelAttempt, lastModelOperationKey);
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
        const completionResponse = authorizationRequired || lastToolUi
          ? agentResponseSchema.parse({
            version: "1",
            text: response.message.content,
            media: [],
            ...(authorizationRequired ? { authorizationRequired } : {}),
            ...(lastToolUi ? { ui: lastToolUi } : {}),
          })
          : undefined;
        return {
          status: "completed",
          messages,
          response,
          ...(completionResponse ? { completionResponse } : {}),
          usage,
          iterations: iteration,
          toolCalls,
        };
      }
      if (response.toolCalls.length > Math.max(0, limits.maxToolCalls - toolCalls)) {
        // A provider may return several calls in one assistant message. Do not execute a
        // prefix when the remaining budget cannot admit the whole message: the resulting
        // assistant/tool sequence would be incomplete and unsafe to checkpoint.
        toolCalls += response.toolCalls.length;
        await emit(input, { type: "loop.limited", iteration, payload: { reason: "tool_calls" } });
        return { status: "limited", messages, response, usage, iterations: iteration, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
      }
      for (const toolCall of response.toolCalls) {
        toolCalls += 1;
        if (toolCalls > limits.maxToolCalls) {
          await emit(input, { type: "loop.limited", iteration, payload: { reason: "tool_calls" } });
          return { status: "limited", messages, response, usage, iterations: iteration, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
        }
        const argumentsHash = hashToolArguments(toolCall.arguments);
        const manifest = input.tools.get(toolCall.name);
        try {
          await input.beforeToolInvoke?.({
            toolCallId: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
            approved: false,
          });
          const replayed = await input.replayToolInvocation?.({ toolCallId: toolCall.id, name: toolCall.name, argumentsHash });
          if (replayed && (replayed.name !== toolCall.name || replayed.argumentsHash !== argumentsHash)) {
            throw new ToolPolicyError("TOOL_REPLAY_SCOPE_CONFLICT", "A durable tool outcome did not match the provider tool call");
          }
          if (!replayed) {
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
          }
          if (!replayed) await input.consumeRunToolCall?.({ parallelLeaseId: input.parallelLeaseId });
          const result = replayed ?? await input.tools.invoke({
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
          const toolAuthorization = findAuthorizationRequirement(result.output);
          const safeOutput = redactSensitiveValue(result.output);
          const durableOutput = redactToolOutput(result.output, manifest?.manifest?.redaction ?? []);
          const toolUi = input.dynamicUiEnabled === false ? undefined : projectCapabilityResultUi({ presentation: manifest?.manifest?.presentation, output: durableOutput, channel: input.uiChannel ?? "platform" });
          if (toolUi || manifest?.manifest?.presentation) lastToolUi = toolUi;
          messages.push({
            role: "tool",
            name: toolCall.name,
            toolCallId: toolCall.id,
            content: JSON.stringify(safeOutput),
          });
          if (toolAuthorization) authorizationRequired = toolAuthorization;
          await emit(input, {
            type: "tool.completed",
            iteration,
            payload: {
              name: toolCall.name,
              latencyMs: result.latencyMs,
              ...(replayed ? { replayed: true } : {}),
              ...(toolAuthorization ? { authorizationRequired: toolAuthorization } : {}),
            },
          });
          if (!replayed) await input.onToolCompleted?.({ toolCallId: toolCall.id, name: toolCall.name, argumentsHash, output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId });
          if (result.control === "final_response") {
            const agentResponse = (safeOutput as { response: AgentResponse }).response;
            const completionResponse = agentResponseSchema.parse({
              ...agentResponse,
              ...(authorizationRequired ? { authorizationRequired } : {}),
              ...(lastToolUi ? { ui: lastToolUi } : {}),
            });
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
      if (error instanceof ModelProviderError) await input.onModelError?.(normalized, lastModelAttempt, lastModelOperationKey);
      await emit(input, { type: "loop.failed", iteration, payload: normalized });
      return { status: "failed", messages, usage, iterations: iteration, toolCalls, error: normalized };
    }
  }
  await emit(input, { type: "loop.limited", iteration: limits.maxIterations, payload: { reason: "iterations" } });
  return { status: "limited", messages, usage, iterations: limits.maxIterations, toolCalls, ...(lastToolUi ? { ui: lastToolUi } : {}) };
}
