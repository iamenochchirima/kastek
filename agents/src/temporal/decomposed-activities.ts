import type { AppConfig } from "../config";
import type { KasitekCoreReadClient } from "../core/client";
import { authorizeInstallationCapability } from "../capabilities/authorization";
import type { ApprovalRepository } from "../db/repositories/approval-repository";
import type { ConversationRepository } from "../db/repositories/conversation-repository";
import type { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import type { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import type { KnowledgeRepository } from "../db/repositories/knowledge-repository";
import type { KasiAiPreferenceRepository } from "../db/repositories/kasiai-preference-repository";
import type { KillSwitchRepository } from "../db/repositories/kill-switch-repository";
import type { MemoryRepository } from "../db/repositories/memory-repository";
import type { ModelCallRepository } from "../db/repositories/model-call-repository";
import type { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import type { RunBudgetRepository } from "../db/repositories/run-budget-repository";
import type { RunRepository, RuntimeRunRecord } from "../db/repositories/run-repository";
import type { RunStepRepository } from "../db/repositories/run-step-repository";
import type { SummaryRepository } from "../db/repositories/summary-repository";
import type { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
import type { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import type { WorkflowStateRepository } from "../db/repositories/workflow-state-repository";
import { MemoryLifecycle } from "../memory/lifecycle";
import { RetrievalService } from "../memory/retrieval";
import { ModelProviderError, type ModelCredentials, type ModelMessage, type ModelProvider, type ModelRequest, type ModelResponse } from "../model/types";
import { resolveModelTarget } from "../model/policy";
import { buildAgentContext } from "../runtime/context";
import { estimatePromptTokens } from "../model/credit-pricing";
import type { ModelCreditPricing } from "../model/credit-pricing";
import { ModelGateway } from "../model/gateway";
import { type ModelCreditReservation } from "../runtime/loop";
import { ToolPolicyError, type ToolInvocationContext } from "../tools/types";
import { hashToolArguments, ToolRegistry } from "../tools/registry";
import { redactSensitiveValue, redactToolOutput } from "../tools/redaction";
import { AGENT_MEDIA_HARNESS_TOOLS, parseAgentResponse } from "../media/contracts";
import { sanitizeAssistantResponse } from "../runtime/context";
import {
  DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
  type DecomposedAgentRunActivities,
  type DecomposedModelActivityInput,
} from "./decomposed-contracts";
import { readDecomposedLoopState, type DecomposedLoopState } from "./decomposed-state";
import type { SkillRepository } from "../db/repositories/skill-repository";
import { matchSkills, renderSkillInstructions } from "../skills/contracts";
import type { RemoteMcpProviderRepository } from "../db/repositories/remote-mcp-provider-repository";

export interface DecomposedActivityDependencies {
  runs: RunRepository;
  modelCalls: ModelCallRepository;
  runBudgets: RunBudgetRepository;
  conversations: ConversationRepository;
  memory: MemoryRepository;
  knowledge: KnowledgeRepository;
  skills?: SkillRepository;
  remoteMcpProviders?: RemoteMcpProviderRepository;
  toolInvocations: ToolInvocationRepository;
  runSteps: RunStepRepository;
  toolGrants: ToolGrantRepository;
  summaries: SummaryRepository;
  killSwitches: KillSwitchRepository;
  controls: OperatorControlRepository;
  kasiaiPreferences: KasiAiPreferenceRepository;
  effectReceipts: EffectReceiptRepository;
  approvals: ApprovalRepository;
  installationGrants: InstallationGrantRepository;
  workflowState: WorkflowStateRepository;
  gateway: ModelGateway;
  credentials: { resolve(provider: ModelProvider, reference: string | undefined, organizationId: string): Promise<ModelCredentials> };
  tools: ToolRegistry;
  coreClient?: KasitekCoreReadClient;
  config?: AppConfig;
  modelPricing: Record<string, { inputUsdPerMillion: number; outputUsdPerMillion: number }>;
  creditPricing: ModelCreditPricing;
  creditBillingMode: AppConfig["CREDIT_BILLING_MODE"];
  heartbeat: (details: Record<string, unknown>) => void;
  reserveModelCredits: (input: {
    context: ToolInvocationContext;
    runId: string;
    operationKey: string;
    request: ModelRequest;
    credentials: ModelCredentials;
  }) => Promise<ModelCreditReservation | undefined>;
  reserveRunBudget: (input: {
    organizationId: string;
    runId: string;
    reservationKey: string;
    request: ModelRequest;
  }) => Promise<ModelCreditReservation>;
  consumeRunToolBudget: (input: { organizationId: string; runId: string }) => Promise<void>;
  buildApprovalResourceSnapshot: (run: RuntimeRunRecord, name: string, argumentsValue: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
  signal: () => AbortSignal | undefined;
}

export function createDecomposedActivities(deps: DecomposedActivityDependencies): DecomposedAgentRunActivities {
  return {
    async buildLoopContext(input) {
      deps.heartbeat({ phase: "decomposed.context.started", runId: input.runId });
      const run = await loadRun(deps, input);
      const current = await readStateRecord(deps, run);
      if (current.raw && Object.prototype.hasOwnProperty.call(current.raw, "__decomposedLoop") && !current.state) throw new Error("DECOMPOSED_LOOP_STATE_INVALID");
      if (isMcpToolRun(run.input) || (run.configuration.workflow && typeof run.configuration.workflow === "object" && !Array.isArray(run.configuration.workflow))) {
        return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, nextPhase: "unsupported" };
      }
      if (current.state) return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, nextPhase: current.state.phase, nextStep: current.state.iteration, ...(current.state.pendingToolCallIds.length ? { pendingToolCallIds: current.state.pendingToolCallIds } : {}), ...(current.state.waitingFor ? { waitingFor: current.state.waitingFor } : {}) };
      const state = await buildInitialState(deps, run);
      const written = await deps.workflowState.put({
        organizationId: run.organization_id,
        runId: run.id,
        expectedRevision: current.revision,
        state: { ...(current.raw ?? {}), __decomposedLoop: state },
      });
      return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: written.revision, nextPhase: state.phase };
    },

    async executeModelStep(input) {
      deps.heartbeat({ phase: "decomposed.model.started", runId: input.runId, step: input.step });
      const run = await loadRun(deps, input);
      const current = await readStateRecord(deps, run);
      const state = requireState(current.state);
      if (state.lastModelOperationKey === input.operationKey && current.revision !== input.inputStateRevision) {
        if (state.phase === "completed") return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, status: "completed" as const };
        return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, status: state.phase === "awaiting_approval" ? "awaiting_approval" as const : "tool_calls" as const, toolCallIds: state.pendingToolCallIds };
      }
      if (current.revision !== input.inputStateRevision) throw new Error("DECOMPOSED_STATE_REVISION_CONFLICT");
      if (state.phase === "completed") return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, status: "completed" as const };
      let modelState = state;
      let modelRevision = current.revision;
      if ((state.phase === "awaiting_human" || state.phase === "awaiting_external_event") && input.resumeExternalEvent) {
        modelState = { ...state, phase: "model", waitingFor: undefined, messages: [...state.messages, { role: "user", content: JSON.stringify({ externalEvent: input.resumeExternalEvent }) }] };
        const resumed = await putState(deps, run, modelRevision, modelState);
        modelRevision = resumed.revision;
      }
      if (modelState.phase === "completed") return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: modelRevision, status: "completed" as const };
      if (modelState.phase === "tool" || modelState.phase === "awaiting_approval") return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: modelRevision, status: modelState.phase === "awaiting_approval" ? "awaiting_approval" as const : "tool_calls" as const, toolCallIds: modelState.pendingToolCallIds };
      if (modelState.phase !== "model") throw new Error("DECOMPOSED_MODEL_PHASE_INVALID");
      const runtime = await loadRuntime(deps, run);
      const request: ModelRequest = {
        provider: runtime.provider,
        model: runtime.model,
        messages: modelState.messages,
        tools: deps.tools.list(runtime.allowedTools),
        maxTokens: Math.max(1, runtime.runBudgetLimits.maxTotalTokens - estimatePromptTokens({ messages: modelState.messages } as ModelRequest)),
        temperature: typeof run.configuration.temperature === "number" ? run.configuration.temperature : undefined,
      };
      const modelContext = toolContext(run);
      const response = await executeModelOperation(deps, run, input, request, runtime.credentials, modelContext);
      const modelStep = await deps.runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider: response.provider, model: response.model, operationKey: input.operationKey } });
      await deps.runSteps.finishStep({ stepId: modelStep.id, status: "completed", output: { totalTokens: response.usage.totalTokens, finishReason: response.finishReason, latencyMs: response.latencyMs } });
      const messages = [...modelState.messages, response.message];
      if (!response.toolCalls.length) {
        const text = sanitizeAssistantResponse(response.message.content);
        if (!text.trim()) return persistFailure(deps, run, modelRevision, modelState, "EMPTY_ASSISTANT_RESPONSE", "The model returned no assistant text");
        const nextState: DecomposedLoopState = {
          ...modelState,
          phase: "completed",
          messages,
          usage: addUsage(modelState.usage, response),
          completion: { response, usage: addUsage(modelState.usage, response), iterations: input.step + 1, toolCalls: modelState.toolCalls },
          lastModelOperationKey: input.operationKey,
          lastModelResponse: response,
        };
        const written = await putState(deps, run, modelRevision, nextState);
        return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: written.revision, status: "completed" as const };
      }

      const pendingToolCallIds: string[] = [];
      const toolStepIds = { ...modelState.toolStepIds };
      let awaitingApproval = false;
      for (const [index, toolCall] of response.toolCalls.entries()) {
        const manifest = deps.tools.get(toolCall.name);
        if (!manifest) continue;
        const argumentsHash = hashToolArguments(toolCall.arguments);
        await deps.toolInvocations.recordProposal({
          organizationId: run.organization_id,
          runId: run.id,
          providerToolCallId: toolCall.id,
          sequenceNumber: modelState.toolCalls + index + 1,
          toolName: toolCall.name,
          toolVersion: manifest.version,
          riskClass: manifest.riskClass,
          argumentsHash,
          arguments: toolCall.arguments,
          requiresApproval: manifest.requiresApproval,
        });
        if (manifest.requiresApproval) {
          awaitingApproval = true;
          const resourceSnapshot = await deps.buildApprovalResourceSnapshot(run, toolCall.name, toolCall.arguments);
          await deps.approvals.createPending({
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            providerToolCallId: toolCall.id,
            capability: toolCall.name,
            capabilityVersion: manifest.version,
            argumentsHash,
            resourceSnapshot: resourceSnapshot ?? {},
            previewRevision: argumentsHash,
            policyRevision: "v1",
            permittedEffectKey: `${run.id}:${toolCall.id}`,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          });
        }
        if (manifest.riskClass === "external-effect") {
          await deps.effectReceipts.reserve({
            organizationId: run.organization_id,
            installationId: run.installation_id,
            runId: run.id,
            providerToolCallId: toolCall.id,
            capability: toolCall.name,
            capabilityVersion: manifest.version,
            argumentsHash,
            idempotencyKey: `${run.id}:${toolCall.name}:${argumentsHash}`,
          });
        }
        const step = await deps.runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "tool", input: { toolCallId: toolCall.id, name: toolCall.name, argumentsHash } });
        toolStepIds[toolCall.id] = step.id;
        pendingToolCallIds.push(toolCall.id);
      }
      if (!pendingToolCallIds.length) return persistFailure(deps, run, modelRevision, modelState, "TOOL_NOT_CONFIGURED", "The model requested an unavailable tool");
      const nextState: DecomposedLoopState = {
        ...modelState,
          phase: awaitingApproval ? "awaiting_approval" : "tool",
          messages,
        usage: addUsage(modelState.usage, response),
        iteration: input.step + 1,
        pendingToolCallIds,
        completedToolCallIds: [],
        toolStepIds,
        lastModelOperationKey: input.operationKey,
        lastModelResponse: response,
      };
      const written = await putState(deps, run, modelRevision, nextState);
      return {
        protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
        stateRevision: written.revision,
        status: awaitingApproval ? "awaiting_approval" as const : "tool_calls" as const,
        toolCallIds: pendingToolCallIds,
      };
    },

    async executeToolStep(input) {
      deps.heartbeat({ phase: "decomposed.tool.started", runId: input.runId, step: input.step, providerToolCallId: input.providerToolCallId });
      const run = await loadRun(deps, input);
      const current = await readStateRecord(deps, run);
      const state = requireState(current.state);
      if (state.completedToolCallIds.includes(input.providerToolCallId)) return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, providerToolCallId: input.providerToolCallId, status: "completed" as const };
      if (!state.pendingToolCallIds.includes(input.providerToolCallId)) throw new Error("DECOMPOSED_TOOL_NOT_PENDING");
      const proposal = await deps.toolInvocations.getProposal(run.organization_id, run.id, input.providerToolCallId);
      if (!proposal) throw new Error("DECOMPOSED_TOOL_PROPOSAL_MISSING");
      const manifest = deps.tools.get(proposal.toolName);
      if (!manifest) throw new Error("DECOMPOSED_TOOL_NOT_REGISTERED");
      if (input.approval && input.approval.argumentsHash !== proposal.argumentsHash) throw new ToolPolicyError("APPROVAL_ARGUMENTS_MISMATCH", "The approval does not match the durable tool proposal");
      const runtime = await loadRuntime(deps, run);
      const resourceSnapshot = input.approval?.resourceSnapshot
        ?? (await deps.approvals.getForRun(run.organization_id, run.id))?.resource_snapshot
        ?? await deps.buildApprovalResourceSnapshot(run, proposal.toolName, proposal.arguments)
        ?? {};
      const replayed = await deps.toolInvocations.getCompleted({ organizationId: run.organization_id, runId: run.id, providerToolCallId: proposal.providerToolCallId, toolName: proposal.toolName, argumentsHash: proposal.argumentsHash });
      if (manifest.requiresApproval && !input.approval && !replayed) return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, providerToolCallId: input.providerToolCallId, status: "awaiting_approval" as const };
      let effectTransitioned = false;
      try {
        await assertCurrentCapabilityPolicy({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          name: proposal.toolName,
          argumentsValue: proposal.arguments,
          grantedTools: runtime.allowedTools,
          tools: deps.tools,
          installationGrants: deps.installationGrants,
          approved: Boolean(input.approval) || Boolean(replayed),
        });
        if (!replayed) {
          if (manifest.riskClass === "external-effect") {
            if (!(await deps.controls.isFeatureEnabled(run.organization_id, "effect_execution_enabled", run.installation_id))) throw new Error("AGENT_EFFECT_FLAG_DISABLED");
            if (await deps.controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "effects" })) throw new Error("AGENT_EFFECT_HOLD_ACTIVE");
          }
          if (manifest.requiresApproval && manifest.riskClass !== "external-effect") {
            if (!input.approval) throw new ToolPolicyError("APPROVAL_REQUIRED", "Tool approval is required");
            await deps.approvals.consume({
              organizationId: run.organization_id,
              installationId: run.installation_id,
              runId: run.id,
              providerToolCallId: proposal.providerToolCallId,
              capability: proposal.toolName,
              capabilityVersion: manifest.version,
              argumentsHash: proposal.argumentsHash,
              resourceSnapshot,
              previewRevision: proposal.argumentsHash,
              policyRevision: "v1",
              permittedEffectKey: `${run.id}:${proposal.providerToolCallId}`,
            });
          }
          await deps.consumeRunToolBudget({ organizationId: run.organization_id, runId: run.id });
        }
        const result = replayed ?? await deps.tools.invoke({
          name: proposal.toolName,
          arguments: proposal.arguments,
          context: toolContext(run),
          signal: deps.signal(),
          grantedTools: runtime.allowedTools,
          approval: input.approval,
          beforeEffect: manifest.riskClass === "external-effect" ? async () => {
            if (!effectTransitioned) {
              if (manifest.requiresApproval) {
                await deps.approvals.consumeAndStartEffect({
                  organizationId: run.organization_id,
                  installationId: run.installation_id,
                  runId: run.id,
                  providerToolCallId: proposal.providerToolCallId,
                  capability: proposal.toolName,
                  capabilityVersion: manifest.version,
                  argumentsHash: proposal.argumentsHash,
                  resourceSnapshot,
                  previewRevision: proposal.argumentsHash,
                  policyRevision: "v1",
                  permittedEffectKey: `${run.id}:${proposal.providerToolCallId}`,
                  effectIdempotencyKey: `${run.id}:${proposal.toolName}:${proposal.argumentsHash}`,
                });
              } else {
                await deps.effectReceipts.markExecutingByKey(run.organization_id, `${run.id}:${proposal.toolName}:${proposal.argumentsHash}`);
              }
              effectTransitioned = true;
            }
          } : undefined,
        });
        const durableOutput = redactToolOutput(result.output, manifest.manifest?.redaction ?? []);
        if (!replayed) await deps.toolInvocations.recordCompleted({ runId: run.id, providerToolCallId: proposal.providerToolCallId, output: durableOutput, latencyMs: result.latencyMs, effectId: result.effectId });
        if (result.effectId) await deps.effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${proposal.toolName}:${proposal.argumentsHash}`, durableOutput);
        const stepId = state.toolStepIds[proposal.providerToolCallId];
        if (stepId && !replayed) await deps.runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
        const safeOutput = redactSensitiveValue(result.output);
        const messages: ModelMessage[] = [...state.messages, { role: "tool", name: proposal.toolName, toolCallId: proposal.providerToolCallId, content: JSON.stringify(safeOutput) }];
        const completedToolCallIds = [...new Set([...state.completedToolCallIds, proposal.providerToolCallId])];
        const allToolsCompleted = state.pendingToolCallIds.every((id) => completedToolCallIds.includes(id));
        const finalResponse = result.control === "final_response" && isRecord(safeOutput) && isRecord(safeOutput.response)
          ? parseAgentResponse(safeOutput.response)
          : undefined;
        const waitingFor = result.control === "awaiting_human"
          && isRecord(safeOutput)
          && typeof safeOutput.handoffRequestId === "string"
          ? safeOutput.handoffRequestId
          : result.control === "awaiting_human" ? proposal.providerToolCallId : undefined;
        const nextState: DecomposedLoopState = {
          ...state,
          phase: finalResponse ? "completed" : waitingFor ? "awaiting_human" : allToolsCompleted ? "model" : state.phase,
          messages,
          toolCalls: state.toolCalls + (replayed ? 0 : 1),
          pendingToolCallIds: waitingFor || allToolsCompleted ? [] : state.pendingToolCallIds,
          completedToolCallIds,
          ...(waitingFor ? { pendingToolCallIds: [], waitingFor, iteration: state.iteration + 1 } : {}),
          ...(finalResponse ? { completion: { response: state.completion?.response ?? state.lastModelResponse ?? blankResponse(run), agentResponse: finalResponse, usage: state.usage, iterations: state.iteration, toolCalls: state.toolCalls + (replayed ? 0 : 1) } } : {}),
        };
        const written = await putState(deps, run, current.revision, nextState);
        return {
          protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
          stateRevision: written.revision,
          providerToolCallId: proposal.providerToolCallId,
          status: finalResponse ? "completed" as const : waitingFor ? "awaiting_human" as const : "completed" as const,
          ...(waitingFor ? { waitingFor } : {}),
          ...(finalResponse ? { terminal: true } : {}),
        };
      } catch (error) {
        const normalized = { code: error instanceof ToolPolicyError ? error.code : "DECOMPOSED_TOOL_FAILED", message: error instanceof Error ? error.message : "Decomposed tool failed" };
        await deps.toolInvocations.recordFailed({ runId: run.id, providerToolCallId: proposal.providerToolCallId, error: normalized }).catch(() => undefined);
        if (manifest.riskClass === "external-effect") {
          const effectKey = `${run.id}:${proposal.toolName}:${proposal.argumentsHash}`;
          if (effectTransitioned) await deps.effectReceipts.markUnknownByKey(run.organization_id, effectKey, normalized).catch(() => undefined);
          else await deps.effectReceipts.markNotExecutedByKey(run.organization_id, effectKey, normalized).catch(() => undefined);
        }
        const stepId = state.toolStepIds[proposal.providerToolCallId];
        if (stepId) await deps.runSteps.finishStep({ stepId, status: "failed", error: normalized }).catch(() => undefined);
        return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision, providerToolCallId: proposal.providerToolCallId, status: "failed" as const, errorCode: normalized.code };
      }
    },

    async checkpointLoop(input) {
      const run = await loadRun(deps, input);
      const current = await readStateRecord(deps, run);
      const state = requireState(current.state);
      if (state.lastCheckpoint?.operationKey === input.operationKey) return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision };
      if (current.revision !== input.stateRevision) throw new Error("DECOMPOSED_CHECKPOINT_REVISION_CONFLICT");
      const nextState = { ...state, lastCheckpoint: { operationKey: input.operationKey, phase: input.phase === "model" ? state.phase : input.phase } };
      const written = await putState(deps, run, current.revision, nextState);
      return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: written.revision };
    },

    async completeRunFromCheckpoint(input) {
      const run = await loadRun(deps, input);
      const current = await readStateRecord(deps, run);
      const state = requireState(current.state);
      if (current.revision !== input.stateRevision) throw new Error("DECOMPOSED_COMPLETION_REVISION_CONFLICT");
      if (run.status !== "completed") {
        if (state.phase !== "completed" || !state.completion) throw new Error("DECOMPOSED_COMPLETION_MISSING");
        const response = state.completion.agentResponse ?? parseAgentResponse({ text: sanitizeAssistantResponse(state.completion.response.message.content) });
        const completed = await deps.runs.completeRun(run.id, {
          status: "completed",
          message: response.text,
          response,
          usage: state.completion.usage,
          iterations: state.completion.iterations,
          toolCalls: state.completion.toolCalls,
          provenance: state.completion.provenance ?? {},
        });
        if (completed.conversation_id) {
          const messages = await deps.conversations.listMessages(completed.organization_id, completed.conversation_id);
          await deps.summaries.rebuildFromMessages({ organizationId: completed.organization_id, conversationId: completed.conversation_id, messages });
        }
      }
      return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: current.revision };
    },
  };
}

async function buildInitialState(deps: DecomposedActivityDependencies, run: RuntimeRunRecord): Promise<DecomposedLoopState> {
  if (run.installation_status !== "active") throw new Error("INSTALLATION_NOT_ACTIVE");
  const runtime = await loadRuntime(deps, run);
  const inputMessage = currentMessage(run);
  const conversation = run.conversation_id ? await deps.conversations.getConversation(run.organization_id, run.conversation_id) : null;
  const durableMessages = run.conversation_id ? (await deps.conversations.listMessages(run.organization_id, run.conversation_id)).filter((message) => message.run_id !== run.id) : [];
  const summary = run.conversation_id ? await deps.summaries.getSummary(run.organization_id, run.conversation_id) : null;
  const retrieval = await new RetrievalService(new MemoryLifecycle(deps.memory), deps.knowledge).retrieve({ organizationId: run.organization_id, agentId: run.agent_definition_id, installationId: run.installation_id, conversationId: run.conversation_id ?? undefined, actorId: run.created_by }, inputMessage, run.policy, { always: run.installation_settings?.profile === "general" });
  const longTermMemory = retrieval.evidence.map((entry) => entry.sourceType === "memory" ? `[memory:${entry.namespace ?? "unknown"}:${entry.rank}] ${entry.text}` : `[knowledge:${entry.sourceId ?? "unknown"}:${entry.chunkIndex ?? 0}:${entry.rank}] ${entry.text}`).join("\n");
  const allowedTools = runtime.allowedTools;
  const pinnedSkills = deps.skills ? await deps.skills.loadPinnedVersions(run.organization_id, run.agent_version_id) : [];
  const installationConnectors = await deps.installationGrants.effective(run.organization_id, run.installation_id);
  const selectedSkills = matchSkills(pinnedSkills, {
    text: inputMessage,
    channel: conversation?.channel_type,
    audience: run.agent_audience,
    grantedCapabilities: allowedTools,
    grantedConnectors: new Set(installationConnectors.connectors),
  });
  const skillInstructions = renderSkillInstructions(selectedSkills);
  const context = buildAgentContext({
    instructions: [run.instructions, skillInstructions].filter(Boolean).join("\n\n"),
    organizationId: run.organization_id,
    agentId: run.agent_definition_id,
    agentVersionId: run.agent_version_id,
    installationId: run.installation_id,
    runId: run.id,
    actorId: run.created_by,
    channelType: conversation?.channel_type,
    currentMessage: inputMessage,
    summary: summary?.summary,
    longTermMemory: longTermMemory || undefined,
    recentMessages: durableMessages.map((message) => ({ direction: message.direction as "inbound" | "outbound" | "system", messageType: message.message_type, content: message.content, createdAt: message.created_at })),
    authorizedTools: deps.tools.list(allowedTools),
    temporaryContext: run.input.context && typeof run.input.context === "object" && !Array.isArray(run.input.context) ? JSON.stringify(run.input.context) : undefined,
    alwaysRetrieveKnowledge: run.installation_settings?.profile === "general",
    retrievalDecision: retrieval.decision,
    budget: { maxMessages: positiveLimit(run.configuration.maxContextMessages, 30), maxContextTokens: positiveLimit(run.configuration.maxContextTokens, 8_000) },
  });
  return {
    version: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION,
    phase: "model",
    messages: context.messages,
    iteration: 0,
    toolCalls: 0,
    usage: emptyUsage(),
    pendingToolCallIds: [],
    completedToolCallIds: [],
    toolStepIds: {},
  };
}

async function executeModelOperation(
  deps: DecomposedActivityDependencies,
  run: RuntimeRunRecord,
  input: DecomposedModelActivityInput,
  request: ModelRequest,
  credentials: ModelCredentials,
  context: ToolInvocationContext,
): Promise<ModelResponse> {
  const prepared = await deps.modelCalls.prepare({ organizationId: run.organization_id, runId: run.id, operationKey: input.operationKey, provider: request.provider, model: request.model, fundingSource: credentials.fundingSource, credentialReference: credentials.credentialReference });
  let runBudgetReservation: ModelCreditReservation | undefined;
  let creditReservation: ModelCreditReservation | undefined;
  try {
    try {
      runBudgetReservation = await deps.reserveRunBudget({ organizationId: run.organization_id, runId: run.id, reservationKey: input.operationKey, request });
    } catch (error) {
      if (!(prepared.status === "completed" && error instanceof Error && error.message === "MODEL_CALL_ALREADY_SETTLED")) throw error;
    }
    if (prepared.status === "unknown") {
      await runBudgetReservation?.markUnknown?.("The worker lost the decomposed model operation before its provider outcome was recorded");
      runBudgetReservation = undefined;
      throw new Error("MODEL_CALL_OUTCOME_UNKNOWN");
    }
    if (prepared.status === "completed") {
      if (!prepared.response) throw new Error("MODEL_CALL_RESPONSE_MISSING");
      creditReservation = await deps.reserveModelCredits({ context, runId: run.id, operationKey: input.operationKey, request, credentials });
      if (runBudgetReservation) await runBudgetReservation.capture(prepared.response).catch((error) => { if (!(error instanceof Error && error.message === "MODEL_CALL_ALREADY_SETTLED")) throw error; });
      await creditReservation?.capture(prepared.response);
      return prepared.response;
    }
    creditReservation = await deps.reserveModelCredits({ context, runId: run.id, operationKey: input.operationKey, request, credentials });
    const response = await deps.gateway.complete(request, credentials);
    await deps.modelCalls.recordCompleted({ organizationId: run.organization_id, runId: run.id, operationKey: input.operationKey, provider: response.provider, model: response.model, fundingSource: credentials.fundingSource, credentialReference: credentials.credentialReference, response, correlationId: run.correlation_id });
    if (runBudgetReservation) { await runBudgetReservation.capture(response); runBudgetReservation = undefined; }
    if (creditReservation) { await creditReservation.capture(response); creditReservation = undefined; }
    return response;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "decomposed model failure";
    if (runBudgetReservation) await runBudgetReservation.release(reason).catch(() => undefined);
    if (creditReservation) await creditReservation.release(reason).catch(() => undefined);
    if (prepared.status === "new" && error instanceof ModelProviderError) await deps.modelCalls.recordFailed({ organizationId: run.organization_id, runId: run.id, operationKey: input.operationKey, provider: request.provider, model: request.model, fundingSource: credentials.fundingSource, error: { code: error.code, message: error.message }, correlationId: run.correlation_id }).catch(() => undefined);
    throw error;
  }
}

async function loadRuntime(deps: DecomposedActivityDependencies, run: RuntimeRunRecord): Promise<{
  provider: ReturnType<typeof resolveModelTarget>["provider"];
  model: string;
  credentials: ModelCredentials;
  allowedTools: Set<string>;
  runBudgetLimits: { maxModelCalls: number; maxToolCalls: number; maxTotalTokens: number; maxEstimatedCostUsd?: number };
}> {
  const configuration = run.configuration;
  const installationSettings = run.installation_settings ?? {};
  const target = resolveModelTarget(configuration, run.policy);
  const runBudgetLimits = {
    maxModelCalls: restrictiveLimit(configuration.maxModelCalls, installationSettings.maxModelCalls) ?? 8,
    maxToolCalls: restrictiveLimit(configuration.maxToolCalls, installationSettings.maxToolCalls) ?? 16,
    maxTotalTokens: restrictiveLimit(target.maxTokensPerRun, configuration.maxTotalTokens, installationSettings.maxTotalTokens) ?? 32_000,
    maxEstimatedCostUsd: restrictiveLimit(target.maxEstimatedCostUsd, configuration.maxEstimatedCostUsd, installationSettings.maxEstimatedCostUsd),
  };
  await deps.runBudgets.ensure({ organizationId: run.organization_id, runId: run.id }, runBudgetLimits);
  const policyTools = new Set(Array.isArray(run.policy.allowedTools) ? run.policy.allowedTools.filter((value): value is string => typeof value === "string") : []);
  const grantedTools = await deps.toolGrants.effectiveTools(run.organization_id, run.agent_version_id, run.installation_id);
  const allowedTools = new Set([...policyTools].filter((name) => grantedTools.has(name)));
  for (const toolName of await deps.remoteMcpProviders?.registerPinnedTools(run.organization_id, run.agent_version_id, deps.tools) ?? []) allowedTools.add(toolName);
  for (const toolName of AGENT_MEDIA_HARNESS_TOOLS) allowedTools.add(toolName);
  if (await deps.killSwitches.isBlocked({ organizationId: run.organization_id, agentId: run.agent_definition_id, installationId: run.installation_id, toolNames: [...allowedTools] })) throw new Error("AGENT_KILL_SWITCH_ACTIVE");
  if (!(await deps.controls.isFeatureEnabled(run.organization_id, "agent_execution_enabled", run.installation_id))) throw new Error("AGENT_EXECUTION_FLAG_DISABLED");
  if (await deps.controls.isHeld({ organizationId: run.organization_id, installationId: run.installation_id, runId: run.id, holdType: "execution" })) throw new Error("AGENT_EXECUTION_HOLD_ACTIVE");
  const isKasiAiInstallation = run.execution_mode === "system_hosted" && run.agent_owner_type === "system" && run.agent_protected === true && run.agent_slug === "kasiai";
  const preference = isKasiAiInstallation ? await deps.kasiaiPreferences.get(run.organization_id, run.installation_id, run.created_by) : null;
  const provider = ((run.reply_channel_type && run.reply_channel_type !== "platform" ? preference?.default_model_provider : run.resolved_model_provider) ?? preference?.default_model_provider ?? run.resolved_model_provider ?? target.provider) as ReturnType<typeof resolveModelTarget>["provider"];
  const model = (run.reply_channel_type && run.reply_channel_type !== "platform" ? preference?.default_model : run.resolved_model) ?? preference?.default_model ?? run.resolved_model ?? target.model;
  const credentialReference = isKasiAiInstallation && typeof preference?.default_credential_reference === "string" ? preference.default_credential_reference : typeof configuration.credentialReference === "string" ? configuration.credentialReference : target.credentialReference;
  const credentials = await deps.credentials.resolve(provider, credentialReference, run.organization_id);
  return { provider, model, credentials, allowedTools, runBudgetLimits };
}

async function persistFailure(deps: DecomposedActivityDependencies, run: RuntimeRunRecord, revision: number, state: DecomposedLoopState, code: string, message: string) {
  const nextState: DecomposedLoopState = { ...state, phase: "failed", failure: { code, message } };
  const written = await putState(deps, run, revision, nextState);
  return { protocolVersion: DECOMPOSED_ACTIVITY_PROTOCOL_VERSION, stateRevision: written.revision, status: "failed" as const, errorCode: code };
}

async function loadRun(deps: DecomposedActivityDependencies, input: { runId: string }): Promise<RuntimeRunRecord> {
  const run = await deps.runs.getRuntimeRunById(input.runId);
  if (!run) throw new Error("Run not found");
  return run;
}

async function readStateRecord(deps: DecomposedActivityDependencies, run: RuntimeRunRecord) {
  const record = await deps.workflowState.get(run.organization_id, run.id);
  return { revision: record?.revision ?? 0, raw: record?.state, state: readDecomposedLoopState(record?.state?.__decomposedLoop) };
}

function requireState(state: DecomposedLoopState | undefined): DecomposedLoopState {
  if (!state) throw new Error("DECOMPOSED_LOOP_STATE_INVALID");
  return state;
}

async function putState(deps: DecomposedActivityDependencies, run: RuntimeRunRecord, revision: number, state: DecomposedLoopState) {
  const current = await deps.workflowState.get(run.organization_id, run.id);
  if ((current?.revision ?? 0) !== revision) throw new Error("DECOMPOSED_STATE_REVISION_CONFLICT");
  return deps.workflowState.put({ organizationId: run.organization_id, runId: run.id, expectedRevision: revision, state: { ...(current?.state ?? {}), __decomposedLoop: state } });
}

function toolContext(run: RuntimeRunRecord): ToolInvocationContext {
  return { organizationId: run.organization_id, agentId: run.agent_definition_id, agentVersionId: run.agent_version_id, installationId: run.installation_id, runId: run.id, conversationId: run.conversation_id ?? undefined, actorId: run.created_by, correlationId: run.correlation_id, memoryPolicy: isRecord(run.policy.memory) ? run.policy.memory : undefined };
}

function isMcpToolRun(input: Record<string, unknown>): boolean {
  const tool = input.mcpTool;
  return Boolean(tool && typeof tool === "object" && !Array.isArray(tool));
}

async function assertCurrentCapabilityPolicy(input: { organizationId: string; installationId: string; name: string; argumentsValue: Record<string, unknown>; grantedTools: ReadonlySet<string>; tools: ToolRegistry; installationGrants: InstallationGrantRepository; approved: boolean }): Promise<void> {
  await authorizeInstallationCapability(input);
}

function currentMessage(run: RuntimeRunRecord): string {
  const value = run.input.message;
  if (typeof value === "string") return value;
  if (isRecord(value)) return typeof value.text === "string" ? value.text : JSON.stringify(value);
  return JSON.stringify(value ?? run.input);
}

function normalizeUsage(response: ModelResponse) { return { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, totalTokens: response.usage.totalTokens, estimatedCostUsd: response.usage.estimatedCostUsd ?? 0 }; }
function emptyUsage() { return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 }; }
function addUsage(current: DecomposedLoopState["usage"], response: ModelResponse): DecomposedLoopState["usage"] {
  const usage = normalizeUsage(response);
  return {
    inputTokens: current.inputTokens + usage.inputTokens,
    outputTokens: current.outputTokens + usage.outputTokens,
    totalTokens: current.totalTokens + usage.totalTokens,
    estimatedCostUsd: current.estimatedCostUsd + usage.estimatedCostUsd,
  };
}
function blankResponse(run: RuntimeRunRecord): ModelResponse { return { provider: "openai", model: run.resolved_model ?? "unknown", message: { role: "assistant", content: "" }, toolCalls: [], finishReason: "tool", usage: emptyUsage(), latencyMs: 0 }; }
function positiveLimit(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; }
function restrictiveLimit(...values: unknown[]): number | undefined { const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0); return numbers.length ? Math.min(...numbers) : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
