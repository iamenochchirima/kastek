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
import { ChannelRepository } from "../db/repositories/channel-repository";
import { KasiAiPreferenceRepository } from "../db/repositories/kasiai-preference-repository";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";

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

export function createDefaultTools(coreClient?: KasitekCoreReadClient): ToolRegistry {
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
    manifest: { ownerService: "agents", requiredScope: "platform.time.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: [] },
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
    manifest: { ownerService: "kasitek-core", requiredScope: "customers.read", resourceSelector: { type: "customer", argument: "customerId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["customer.email", "customer.phone"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getCustomer(context, String(args.customerId));
    },
  });
  tools.register({
    name: "kasitek.core.workspace_status",
    version: "1.0.0",
    description: "Read connection providers and health statuses for the current KasiTek workspace.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: { organizationId: { type: "string" }, connections: { type: "array" } },
      required: ["organizationId", "connections"],
      additionalProperties: false,
    },
    manifest: { ownerService: "kasitek-core", requiredScope: "connections.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: ["connections.credentials"] },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getWorkspaceStatus(context);
    },
  });
  return tools;
}

function restrictiveLimit(...values: unknown[]): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return numbers.length ? Math.min(...numbers) : undefined;
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
  const channels = new ChannelRepository(pool);
  const kasiaiPreferences = new KasiAiPreferenceRepository(pool);
  const effectReceipts = new EffectReceiptRepository(pool);
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
      return executeLoopForRun(run, input.resumeApprovedToolCall, runs, modelCalls, conversations, memory, knowledge, toolInvocations, effectReceipts, runSteps, toolGrants, summaries, killSwitches, kasiaiPreferences, gateway, credentials, tools);
    },
    async pauseRun(input) {
      await runs.pauseRun(input.runId, input.status, input.output);
    },
    async completeRun(input) {
      const completed = await runs.completeRun(input.runId, input.output);
      if (completed.conversation_id) {
        try {
          const messages = await conversations.listMessages(completed.organization_id, completed.conversation_id);
          await summaries.rebuildFromMessages({
            organizationId: completed.organization_id,
            conversationId: completed.conversation_id,
            messages,
          });
        } catch (error) {
          await runs.appendEvent({
            organizationId: completed.organization_id,
            runId: completed.id,
            installationId: completed.installation_id,
            eventType: "agent.summary.failed",
            payload: { message: error instanceof Error ? error.message : "Conversation summary failed" },
          });
        }
      }
    },
    async generateConversationTitle(input) {
      try {
        const run = await runs.getRuntimeRunById(input.runId);
        if (!run?.conversation_id) return;
        const candidate = await conversations.getTitleCandidate(run.organization_id, run.conversation_id);
        if (!candidate || candidate.title_locked || candidate.title_source !== "fallback" || !candidate.first_message) return;
        const configuration = run.configuration;
        const target = resolveModelTarget(configuration, run.policy);
        const provider = (run.resolved_model_provider ?? target.provider) as typeof target.provider;
        const model = run.resolved_model ?? target.model;
        const credentialReference = typeof configuration.credentialReference === "string" ? configuration.credentialReference : undefined;
        const modelCredentials = await credentials.resolve(provider, credentialReference, run.organization_id);
        const response = await gateway.complete({
          provider,
          model,
          temperature: 0,
          maxTokens: 24,
          timeoutMs: 12_000,
          maxAttempts: 1,
          messages: [
            { role: "system", content: "Create a concise 3 to 7 word chat title. Return only the title, no quotes, punctuation, Markdown, or explanation." },
            { role: "user", content: candidate.first_message.slice(0, 1_000) },
          ],
        }, modelCredentials);
        const title = response.message.content
          .replace(/[\r\n]+/g, " ")
          .replace(/^[-#*\s\"']+|[-#*\s\"']+$/g, "")
          .trim()
          .slice(0, 120);
        if (!title || /^(?:hi|hello|hey|yo|new chat)(?:[!,.?\s]+)?$/i.test(title)) return;
        const updated = await conversations.setGeneratedTitle({
          organizationId: run.organization_id,
          conversationId: run.conversation_id,
          title,
        });
        if (updated) {
          await runs.appendEvent({
            organizationId: run.organization_id,
            runId: run.id,
            installationId: run.installation_id,
            eventType: "conversation.title.generated",
            payload: { conversationId: run.conversation_id },
          });
        }
      } catch (error) {
        // A conversation title is decorative metadata. Never fail or retry the
        // completed user run because a provider cannot generate one.
        void error;
      }
    },
    async deliverRunReply(input) {
      const pending = await channels.getRunReplyDelivery(input.runId);
      if (!pending) return;
      let claimed = false;
      try {
        await channels.claimDelivery(pending.organization_id, pending.attempt_id);
        claimed = true;
        if (!coreClient) throw new Error("kasitek-core channel delivery boundary is not configured");
        const text = typeof pending.content.text === "string" ? pending.content.text.trim() : "";
        if (!text) throw new Error("External channel reply has no text content");
        const result = await coreClient.deliverChannelMessage({
          organizationId: pending.organization_id,
          installationId: pending.installation_id,
          actorId: pending.actor_id,
          runId: pending.run_id,
          correlationId: pending.correlation_id,
          channelType: pending.channel_type,
          externalConversationId: pending.external_conversation_id,
          text,
        });
        await channels.markDelivered({
          organizationId: pending.organization_id,
          attemptId: pending.attempt_id,
          providerMessageId: result.providerMessageId,
        });
        await runs.appendEvent({
          organizationId: pending.organization_id,
          runId: pending.run_id,
          installationId: pending.installation_id,
          eventType: "agent.reply.delivered",
          payload: { channelType: pending.channel_type, status: result.status },
        });
      } catch (error) {
        if (claimed) {
          await channels.markDeliveryFailed({
            organizationId: pending.organization_id,
            attemptId: pending.attempt_id,
            error: { code: "CHANNEL_DELIVERY_FAILED", message: error instanceof Error ? error.message : "Channel delivery failed" },
          });
        }
        await runs.appendEvent({
          organizationId: pending.organization_id,
          runId: pending.run_id,
          installationId: pending.installation_id,
          eventType: "agent.reply.delivery_failed",
          payload: { channelType: pending.channel_type, message: error instanceof Error ? error.message : "Channel delivery failed" },
        });
      }
    },
    async failRun(input) {
      await runs.failRun(input.runId, input.error);
    },
    async recordApprovalDecision(input) {
      await toolInvocations.recordApprovalDecision(input);
      if (input.decision === "rejected") {
        const run = await runs.getRuntimeRunById(input.runId);
        if (run) await effectReceipts.markNotExecuted(run.organization_id, input.runId, input.providerToolCallId, { code: "APPROVAL_REJECTED", message: "The requested effect was denied before execution" });
      }
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
  effectReceipts: EffectReceiptRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  summaries: SummaryRepository,
  killSwitches: KillSwitchRepository,
  kasiaiPreferences: KasiAiPreferenceRepository,
  gateway: ModelGateway,
  credentials: CredentialResolver,
  tools: ToolRegistry,
) {
  const configuration = run.configuration;
  const installationSettings = run.installation_settings ?? {};
  const modelTarget = resolveModelTarget(configuration, run.policy);
  const provider = (run.resolved_model_provider ?? modelTarget.provider) as typeof modelTarget.provider;
  const model = run.resolved_model ?? modelTarget.model;
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
  const preference = await kasiaiPreferences.get(run.organization_id, run.installation_id, run.created_by);
  const preferenceInstruction = preference?.use_saved_preferences
    ? [
      preference.language ? `Reply in ${preference.language} unless the user asks for another language.` : null,
      preference.tone ? `Use a ${preference.tone} communication style.` : null,
      preference.response_detail ? `Aim for ${preference.response_detail} response detail.` : null,
    ].filter((value): value is string => Boolean(value)).join(" ")
    : "";
  const durableMessages = run.conversation_id
    ? (await conversations.listMessages(run.organization_id, run.conversation_id)).filter((message) => message.run_id !== run.id)
    : [];
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
    instructions: [run.instructions, preferenceInstruction].filter(Boolean).join("\n\n"),
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
    temporaryContext: run.input.context && typeof run.input.context === "object" && !Array.isArray(run.input.context)
      ? JSON.stringify(run.input.context)
      : undefined,
    budget: {
      maxMessages: restrictiveLimit(configuration.maxContextMessages, installationSettings.maxContextMessages),
      maxContextTokens: restrictiveLimit(configuration.maxContextTokens, installationSettings.maxContextTokens),
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
      maxTotalTokens: restrictiveLimit(modelTarget.maxTokensPerRun, configuration.maxTotalTokens, installationSettings.maxTotalTokens),
      maxEstimatedCostUsd: restrictiveLimit(modelTarget.maxEstimatedCostUsd, installationSettings.maxEstimatedCostUsd),
      maxWallTimeMs: typeof configuration.maxWallTimeMs === "number" ? configuration.maxWallTimeMs : undefined,
    },
    beforeModelCall: () => modelCalls.assertRunBudget({
      organizationId: run.organization_id,
      runId: run.id,
      maxTotalTokens: restrictiveLimit(modelTarget.maxTokensPerRun, configuration.maxTotalTokens, installationSettings.maxTotalTokens),
      maxEstimatedCostUsd: restrictiveLimit(modelTarget.maxEstimatedCostUsd, installationSettings.maxEstimatedCostUsd),
      maxRequests: restrictiveLimit(configuration.maxModelCalls, installationSettings.maxModelCalls),
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
      if (proposal.riskClass === "external-effect") {
        await effectReceipts.reserve({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: proposal.toolCallId,
          capability: proposal.name,
          capabilityVersion: proposal.version,
          argumentsHash: proposal.argumentsHash,
          idempotencyKey: `${run.id}:${proposal.name}:${proposal.argumentsHash}`,
        });
      }
      const step = await runSteps.startStep({ runId: run.id, organizationId: run.organization_id, stepType: "tool", input: { toolCallId: proposal.toolCallId, name: proposal.name, argumentsHash: proposal.argumentsHash } });
      toolSteps.set(proposal.toolCallId, step.id);
    },
    onToolExecuting: async (execution) => {
      await effectReceipts.markExecutingByKey(run.organization_id, `${run.id}:${execution.name}:${execution.argumentsHash}`);
    },
    onToolCompleted: async (result) => {
      await toolInvocations.recordCompleted({
        runId: run.id,
        providerToolCallId: result.toolCallId,
        output: result.output,
        latencyMs: result.latencyMs,
        effectId: result.effectId,
        approval: result.approval,
      });
      if (result.effectId) await effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${result.name}:${result.argumentsHash}`, result.output);
      const stepId = toolSteps.get(result.toolCallId);
      if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
    },
    onToolFailed: async (failure) => {
      await toolInvocations.recordFailed({
        runId: run.id,
        providerToolCallId: failure.toolCallId,
        error: failure.error,
      });
      const failedTool = tools.get(failure.name);
      if (failedTool?.riskClass === "external-effect" && failure.argumentsHash) {
        await effectReceipts.markFailedByKey(run.organization_id, `${run.id}:${failure.name}:${failure.argumentsHash}`, failure.error, false);
      }
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
  return loopResult;
}
