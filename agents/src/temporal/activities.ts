import type { Pool } from "pg";
import { RunRepository } from "../db/repositories/run-repository";
import { ModelCallRepository } from "../db/repositories/model-call-repository";
import { ConversationRepository } from "../db/repositories/conversation-repository";
import { MemoryRepository } from "../db/repositories/memory-repository";
import { KnowledgeRepository } from "../db/repositories/knowledge-repository";
import type { AgentRunActivities } from "./contracts";
import { ModelGateway } from "../model/gateway";
import { EnvironmentCredentialResolver, VaultCredentialResolver, type CredentialResolver } from "../model/credentials";
import type { ModelPricing } from "../model/types";
import { runBoundedAgentLoop } from "../runtime/loop";
import { buildAgentContext } from "../runtime/context";
import { retrievalGate } from "../runtime/context";
import { ToolRegistry } from "../tools/registry";
import { KasitekCoreReadClient } from "../core/client";
import type { AppConfig } from "../config";
import { ToolInvocationRepository } from "../db/repositories/tool-invocation-repository";
import { RunStepRepository } from "../db/repositories/run-step-repository";
import { ToolGrantRepository } from "../db/repositories/tool-grant-repository";
import { SummaryRepository } from "../db/repositories/summary-repository";
import { CredentialVaultRepository } from "../db/repositories/credential-vault-repository";
import { resolveModelTarget } from "../model/policy";
import { KillSwitchRepository } from "../db/repositories/kill-switch-repository";

export interface ActivityOptions {
  gateway?: ModelGateway;
  credentials?: CredentialResolver;
  tools?: ToolRegistry;
  coreClient?: KasitekCoreReadClient;
  config?: AppConfig;
}

function pricingFromConfig(config?: AppConfig): Record<string, ModelPricing> {
  if (!config?.MODEL_PRICING_JSON) return {};
  try {
    const parsed = JSON.parse(config.MODEL_PRICING_JSON) as Record<string, ModelPricing>;
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => Number.isFinite(value.inputUsdPerMillion) && Number.isFinite(value.outputUsdPerMillion)));
  } catch {
    throw new Error("MODEL_PRICING_JSON must be valid JSON");
  }
}

function createDefaultTools(coreClient?: KasitekCoreReadClient): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    name: "platform.current_time",
    version: "1.0.0",
    description: "Get the current UTC time from the trusted platform runtime.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 1000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { iso: { type: "string" } },
      required: ["iso"],
      additionalProperties: false,
    },
    handler: async () => ({ iso: new Date().toISOString() }),
  });
  tools.register({
    name: "kasitek.core.customer_get",
    version: "1.0.0",
    description: "Read a customer profile and scoped history from kasitek-core.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: {
      type: "object",
      properties: { customerId: { type: "string", minLength: 1, maxLength: 160 } },
      required: ["customerId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["customer"], additionalProperties: true },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getCustomer(context, String(args.customerId));
    },
  });
  return tools;
}

export function createActivities(pool: Pool, options: ActivityOptions = {}): AgentRunActivities {
  const runs = new RunRepository(pool);
  const modelCalls = new ModelCallRepository(pool);
  const conversations = new ConversationRepository(pool);
  const memory = new MemoryRepository(pool);
  const knowledge = new KnowledgeRepository(pool);
  const toolInvocations = new ToolInvocationRepository(pool);
  const runSteps = new RunStepRepository(pool);
  const toolGrants = new ToolGrantRepository(pool);
  const summaries = new SummaryRepository(pool);
  const killSwitches = new KillSwitchRepository(pool);
  const gateway = options.gateway ?? new ModelGateway(undefined, { pricing: pricingFromConfig(options.config) });
  const credentials = options.credentials ?? (options.config
    ? new VaultCredentialResolver(new CredentialVaultRepository(pool, options.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY))
    : new EnvironmentCredentialResolver());
  const coreClient = options.coreClient ?? (options.config ? new KasitekCoreReadClient(options.config) : undefined);
  const tools = options.tools ?? createDefaultTools(coreClient);
  return {
    async transitionRun(input) {
      await runs.transitionRun(input.runId, input.expectedStatus, input.nextStatus);
    },
    async executeLoop(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run) throw new Error("Run not found");
      return executeLoopForRun(run, input.resumeApprovedToolCall, runs, modelCalls, conversations, memory, knowledge, toolInvocations, runSteps, toolGrants, summaries, killSwitches, gateway, credentials, tools);
    },
    async pauseRun(input) {
      await runs.pauseRun(input.runId, input.status, input.output);
    },
    async completeRun(input) {
      await runs.completeRun(input.runId, input.output);
    },
    async failRun(input) {
      await runs.failRun(input.runId, input.error);
    },
    async recordApprovalDecision(input) {
      await toolInvocations.recordApprovalDecision(input);
    },
  };
}

async function executeLoopForRun(
  run: Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object,
  resumeApprovedToolCall: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"],
  runs: RunRepository,
  modelCalls: ModelCallRepository,
  conversations: ConversationRepository,
  memory: MemoryRepository,
  knowledge: KnowledgeRepository,
  toolInvocations: ToolInvocationRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  summaries: SummaryRepository,
  killSwitches: KillSwitchRepository,
  gateway: ModelGateway,
  credentials: CredentialResolver,
  tools: ToolRegistry,
) {
  const configuration = run.configuration;
  const modelTarget = resolveModelTarget(configuration, run.policy);
  const provider = modelTarget.provider;
  const model = modelTarget.model;
  const policyTools = new Set(
    Array.isArray(run.policy.allowedTools) ? run.policy.allowedTools.filter((value): value is string => typeof value === "string") : [],
  );
  const grantedTools = await toolGrants.effectiveTools(run.organization_id, run.agent_version_id, run.installation_id);
  const allowedTools = new Set([...policyTools].filter((toolName) => grantedTools.has(toolName)));
  if (await killSwitches.isBlocked({ organizationId: run.organization_id, agentId: run.agent_definition_id, installationId: run.installation_id, toolNames: [...allowedTools] })) {
    throw new Error("AGENT_KILL_SWITCH_ACTIVE");
  }
  const credentialReference = typeof configuration.credentialReference === "string" ? configuration.credentialReference : undefined;
  const modelCredentials = await credentials.resolve(provider, credentialReference, run.organization_id);
  const currentMessage = typeof run.input.message === "string" ? run.input.message : JSON.stringify(run.input);
  const conversation = run.conversation_id ? await conversations.getConversation(run.organization_id, run.conversation_id) : null;
  const durableMessages = run.conversation_id ? await conversations.listMessages(run.organization_id, run.conversation_id) : [];
  const conversationSummary = run.conversation_id ? await summaries.getSummary(run.organization_id, run.conversation_id) : null;
  const retrievalRequested = retrievalGate(currentMessage);
  const retrievalScope = {
    organizationId: run.organization_id,
    agentId: run.agent_definition_id,
    installationId: run.installation_id,
    conversationId: run.conversation_id ?? undefined,
    actorId: run.created_by,
  };
  const memoryMatches = retrievalRequested ? await memory.searchMemory(retrievalScope, currentMessage) : [];
  const knowledgeMatches = retrievalRequested ? await knowledge.search(retrievalScope, currentMessage) : [];
  const retrievalStep = await runSteps.startStep({
    runId: run.id,
    organizationId: run.organization_id,
    stepType: "retrieval",
    input: { requested: retrievalRequested, query: retrievalRequested ? currentMessage : undefined },
  });
  await runSteps.finishStep({
    stepId: retrievalStep.id,
    status: "completed",
    output: { memoryMatchCount: memoryMatches.length, knowledgeMatchCount: knowledgeMatches.length },
  });
  const longTermMemory = [
    ...memoryMatches.map((entry) => `[memory:${entry.memory_type}] ${entry.canonical_text}`),
    ...knowledgeMatches.map((entry) => `[knowledge:${entry.source_id}:${entry.chunk_index}] ${entry.canonical_text}`),
  ].join("\n");
  const context = buildAgentContext({
    instructions: run.instructions,
    organizationId: run.organization_id,
    agentId: run.agent_definition_id,
    agentVersionId: run.agent_version_id,
    installationId: run.installation_id,
    runId: run.id,
    actorId: run.created_by,
    channelType: conversation?.channel_type,
    currentMessage,
    summary: conversationSummary?.summary,
    longTermMemory: longTermMemory || undefined,
    recentMessages: durableMessages.map((message) => ({
      direction: message.direction as "inbound" | "outbound" | "system",
      messageType: message.message_type,
      content: message.content,
      createdAt: message.created_at,
    })),
    authorizedTools: tools.list(allowedTools),
    budget: {
      maxMessages: typeof configuration.maxContextMessages === "number" ? configuration.maxContextMessages : undefined,
      maxContextTokens: typeof configuration.maxContextTokens === "number" ? configuration.maxContextTokens : undefined,
    },
  });
  const contextStep = await runSteps.startStep({
    runId: run.id,
    organizationId: run.organization_id,
    stepType: "context",
    input: { messageCount: durableMessages.length },
  });
  await runSteps.finishStep({
    stepId: contextStep.id,
    status: "completed",
    output: { estimatedTokens: context.estimatedTokens, messageCount: context.messages.length },
  });
  await runs.appendEvent({
    organizationId: run.organization_id,
    runId: run.id,
    installationId: run.installation_id,
    eventType: "agent.context.built",
    payload: {
      estimatedTokens: context.estimatedTokens,
      omittedMessageCount: context.omittedMessageCount,
      retrievalRequested: context.retrievalRequested,
      messageCount: context.messages.length,
      memoryMatchCount: memoryMatches.length,
      knowledgeMatchCount: knowledgeMatches.length,
    },
  });
  const toolSteps = new Map<string, string>();
  const loopResult = await runBoundedAgentLoop({
    model: { provider, model, temperature: typeof configuration.temperature === "number" ? configuration.temperature : undefined },
    messages: context.messages,
    credentials: modelCredentials,
    gateway,
    tools,
    grantedTools: allowedTools,
    toolContext: {
      organizationId: run.organization_id,
      agentId: run.agent_definition_id,
      agentVersionId: run.agent_version_id,
      installationId: run.installation_id,
      runId: run.id,
      actorId: run.created_by,
      correlationId: run.correlation_id,
    },
    limits: {
      maxIterations: typeof configuration.maxIterations === "number" ? configuration.maxIterations : undefined,
      maxToolCalls: typeof configuration.maxToolCalls === "number" ? configuration.maxToolCalls : undefined,
      maxTotalTokens: modelTarget.maxTokensPerRun ?? (typeof configuration.maxTotalTokens === "number" ? configuration.maxTotalTokens : undefined),
      maxEstimatedCostUsd: modelTarget.maxEstimatedCostUsd,
      maxWallTimeMs: typeof configuration.maxWallTimeMs === "number" ? configuration.maxWallTimeMs : undefined,
    },
    beforeModelCall: () => modelCalls.assertRunBudget({
      organizationId: run.organization_id,
      runId: run.id,
      maxTotalTokens: modelTarget.maxTokensPerRun ?? (typeof configuration.maxTotalTokens === "number" ? configuration.maxTotalTokens : undefined),
      maxEstimatedCostUsd: modelTarget.maxEstimatedCostUsd,
      maxRequests: typeof configuration.maxModelCalls === "number" ? configuration.maxModelCalls : undefined,
    }),
    resumeApprovedToolCall,
    onEvent: (event) => runs.appendEvent({
      organizationId: run.organization_id,
      runId: run.id,
      installationId: run.installation_id,
      eventType: `agent.${event.type}`,
      payload: event.payload,
    }),
    onToolProposed: async (proposal) => {
      await toolInvocations.recordProposal({
        organizationId: run.organization_id,
        runId: run.id,
        providerToolCallId: proposal.toolCallId,
        sequenceNumber: proposal.sequenceNumber,
        toolName: proposal.name,
        toolVersion: proposal.version,
        riskClass: proposal.riskClass,
        argumentsHash: proposal.argumentsHash,
        arguments: proposal.arguments,
        requiresApproval: proposal.requiresApproval,
      });
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "tool", input: { toolCallId: proposal.toolCallId, name: proposal.name, argumentsHash: proposal.argumentsHash } });
      toolSteps.set(proposal.toolCallId, step.id);
    },
    onToolCompleted: async (result) => {
      await toolInvocations.recordCompleted({
        runId: run.id,
        providerToolCallId: result.toolCallId,
        output: result.output,
        latencyMs: result.latencyMs,
        approval: result.approval,
      });
      const stepId = toolSteps.get(result.toolCallId);
      if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
    },
    onToolFailed: async (failure) => {
      await toolInvocations.recordFailed({
        runId: run.id,
        providerToolCallId: failure.toolCallId,
        error: failure.error,
      });
      const stepId = toolSteps.get(failure.toolCallId);
      if (stepId) await runSteps.finishStep({ stepId, status: "failed", error: failure.error });
    },
    onModelResponse: async (response) => {
      await modelCalls.recordCompleted({
        organizationId: run.organization_id,
        runId: run.id,
        provider: response.provider,
        model: response.model,
        fundingSource: modelCredentials.fundingSource,
        credentialReference: modelCredentials.credentialReference,
        response,
      });
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider: response.provider, model: response.model } });
      await runSteps.finishStep({ stepId: step.id, status: "completed", output: { totalTokens: response.usage.totalTokens, finishReason: response.finishReason, latencyMs: response.latencyMs } });
    },
    onModelError: async (error) => {
      await modelCalls.recordFailed({
        organizationId: run.organization_id,
        runId: run.id,
        provider,
        model,
        fundingSource: modelCredentials.fundingSource,
        error,
      });
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "model", input: { provider, model } });
      await runSteps.finishStep({ stepId: step.id, status: "failed", error });
    },
  });
  if (run.conversation_id) {
    try {
      await summaries.rebuildFromMessages({ organizationId: run.organization_id, conversationId: run.conversation_id, messages: durableMessages });
    } catch (error) {
      await runs.appendEvent({
        organizationId: run.organization_id,
        runId: run.id,
        installationId: run.installation_id,
        eventType: "agent.summary.failed",
        payload: { message: error instanceof Error ? error.message : "Conversation summary failed" },
      });
    }
  }
  return loopResult;
}
