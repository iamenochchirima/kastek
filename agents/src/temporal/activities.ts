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
import { hashToolArguments, ToolRegistry } from "../tools/registry";
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
import { ApprovalRepository } from "../db/repositories/approval-repository";
import { InstallationGrantRepository } from "../db/repositories/installation-grant-repository";
import { evaluateCapabilityPolicy } from "../capabilities/policy";

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
  tools.register({
    name: "kasitek.core.content_posts_list",
    version: "1.0.0",
    description: "List the current workspace's content drafts, schedules, and publication records.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object", properties: { posts: { type: "array" } }, required: ["posts"], additionalProperties: false },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["posts.publishJobs.providerReceipt"] },
    handler: async (context) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.listContentPosts(context);
    },
  });
  tools.register({
    name: "kasitek.core.content_post_get",
    version: "1.0.0",
    description: "Read one workspace-owned content post and its safe publication status.",
    riskClass: "read",
    requiresApproval: false,
    timeoutMs: 12_000,
    inputSchema: { type: "object", properties: { postId: { type: "string", minLength: 1, maxLength: 160 } }, required: ["postId"], additionalProperties: false },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.read", resourceSelector: { type: "content_post", argument: "postId" }, execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "restricted", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core read boundary is not configured");
      return coreClient.getContentPost(context, String(args.postId));
    },
  });
  tools.register({
    name: "kasitek.core.content_post_draft",
    version: "1.0.0",
    description: "Create a workspace content draft without publishing it to any provider.",
    riskClass: "draft",
    requiresApproval: false,
    timeoutMs: 15_000,
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 240 },
        prompt: { type: "string", maxLength: 4_000 },
        content: { type: "string", minLength: 1, maxLength: 100_000 },
        channels: { type: "array", items: { type: "string", minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 20 },
        primaryChannelId: { type: "string", minLength: 1, maxLength: 160 },
        channelSelections: { type: "object", additionalProperties: { type: "string", minLength: 1, maxLength: 160 } },
        variants: { type: "array", items: { type: "object" }, maxItems: 20 },
        metadata: { type: "object" },
      },
      required: ["content", "channels"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.write", execution: "immediate", idempotency: "required", approval: "none", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.createContentDraft(context, {
        title: typeof args.title === "string" ? args.title : undefined,
        prompt: typeof args.prompt === "string" ? args.prompt : undefined,
        content: String(args.content),
        channels: Array.isArray(args.channels) ? args.channels.map(String) : [],
        primaryChannelId: typeof args.primaryChannelId === "string" ? args.primaryChannelId : undefined,
        channelSelections: args.channelSelections && typeof args.channelSelections === "object" ? args.channelSelections as Record<string, string> : undefined,
        variants: Array.isArray(args.variants) ? args.variants as Array<{ platform: string; content: string; status?: string; aiGenerated?: boolean; metadata?: Record<string, unknown> }> : undefined,
        metadata: args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : undefined,
      });
    },
  });
  tools.register({
    name: "kasitek.core.content_post_publish",
    version: "1.0.0",
    description: "Publish an approved content post to one configured social channel.",
    riskClass: "external-effect",
    requiresApproval: true,
    timeoutMs: 60_000,
    inputSchema: {
      type: "object",
      properties: {
        postId: { type: "string", minLength: 1, maxLength: 160 },
        platform: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["postId", "platform"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", required: ["post", "result"], additionalProperties: true },
    manifest: { ownerService: "kasitek-core", requiredScope: "content.publish", resourceSelector: { type: "content_post", argument: "postId" }, execution: "durable", idempotency: "required", approval: "always", auditClassification: "full", redaction: ["post.publishJobs.providerReceipt"] },
    handler: async (context, args) => {
      if (!coreClient) throw new Error("kasitek-core write boundary is not configured");
      return coreClient.publishContentPost(context, String(args.postId), String(args.platform));
    },
  });
  return tools;
}

function restrictiveLimit(...values: unknown[]): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return numbers.length ? Math.min(...numbers) : undefined;
}

async function assertCurrentCapabilityPolicy(input: {
  organizationId: string;
  installationId: string;
  name: string;
  argumentsValue: Record<string, unknown>;
  grantedTools: ReadonlySet<string>;
  tools: ToolRegistry;
  installationGrants: InstallationGrantRepository;
  approved: boolean;
}): Promise<void> {
  const manifest = input.tools.get(input.name);
  if (!manifest) throw new Error(`Tool is not registered: ${input.name}`);
  const selector = manifest.manifest?.resourceSelector;
  const selected = selector?.argument ? input.argumentsValue[selector.argument] : undefined;
  const requestedResources = selector && typeof selected === "string" && selected.trim()
    ? [{ type: selector.type, id: selected.trim() }]
    : undefined;
  const grants = await input.installationGrants.effective(input.organizationId, input.installationId);
  const decision = evaluateCapabilityPolicy({
    capability: input.name,
    grantedCapabilities: input.grantedTools,
    requestedResources,
    grantedResources: grants.resources,
    available: manifest.manifest?.availability !== "not_configured" && manifest.manifest?.availability !== "unhealthy",
    requiresApproval: manifest.requiresApproval,
    approved: input.approved,
  });
  if (!decision.allowed) throw new Error(decision.code);
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
  const approvals = new ApprovalRepository(pool);
  const installationGrants = new InstallationGrantRepository(pool);
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
      if (isMcpToolRun(run.input)) {
        return executeMcpToolRun(
          run,
          input.resumeApprovedToolCall,
          runs,
          toolInvocations,
          approvals,
          effectReceipts,
          runSteps,
          toolGrants,
          installationGrants,
          killSwitches,
          tools,
        );
      }
      return executeLoopForRun(run, input.resumeApprovedToolCall, runs, modelCalls, conversations, memory, knowledge, toolInvocations, approvals, effectReceipts, runSteps, toolGrants, installationGrants, summaries, killSwitches, kasiaiPreferences, gateway, credentials, tools);
    },
    async pauseRun(input) {
      await runs.pauseRun(input.runId, input.status, input.output);
    },
    async cancelPendingApproval(input) {
      const run = await runs.getRuntimeRunById(input.runId);
      if (!run) throw new Error("Run not found");
      await approvals.cancel(run.organization_id, run.id, input.providerToolCallId);
      await effectReceipts.markNotExecuted(run.organization_id, run.id, input.providerToolCallId, {
        code: "RUN_CANCELLED",
        message: input.reason ?? "The run was cancelled before the approved effect began",
      });
      await runs.appendEvent({
        organizationId: run.organization_id,
        runId: run.id,
        installationId: run.installation_id,
        eventType: input.outcome === "expired" ? "agent.approval.expired" : "agent.approval.cancelled",
        payload: { providerToolCallId: input.providerToolCallId },
      });
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
  };
}

function isMcpToolRun(input: Record<string, unknown>): input is Record<string, unknown> & { mcpTool: { name: string; arguments: Record<string, unknown>; toolCallId: string } } {
  const tool = input.mcpTool;
  return Boolean(
    tool
      && typeof tool === "object"
      && typeof (tool as Record<string, unknown>).name === "string"
      && typeof (tool as Record<string, unknown>).toolCallId === "string"
      && (tool as Record<string, unknown>).arguments
      && typeof (tool as Record<string, unknown>).arguments === "object"
      && !Array.isArray((tool as Record<string, unknown>).arguments),
  );
}

async function executeMcpToolRun(
  run: Awaited<ReturnType<RunRepository["getRuntimeRun"]>> & object,
  resumeApprovedToolCall: Parameters<AgentRunActivities["executeLoop"]>[0]["resumeApprovedToolCall"],
  runs: RunRepository,
  toolInvocations: ToolInvocationRepository,
  approvals: ApprovalRepository,
  effectReceipts: EffectReceiptRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  installationGrants: InstallationGrantRepository,
  killSwitches: KillSwitchRepository,
  tools: ToolRegistry,
) {
  if (!isMcpToolRun(run.input)) throw new Error("Invalid MCP run input");
  const invocation = resumeApprovedToolCall ?? {
    id: run.input.mcpTool.toolCallId,
    name: run.input.mcpTool.name,
    arguments: run.input.mcpTool.arguments,
  };
  const manifest = tools.get(invocation.name);
  if (!manifest) throw new Error(`Tool is not registered: ${invocation.name}`);
  const argumentsHash = hashToolArguments(invocation.arguments);
  const grantedTools = await toolGrants.effectiveTools(run.organization_id, run.agent_version_id, run.installation_id);
  if (!grantedTools.has(invocation.name)) throw new Error(`Tool is not granted: ${invocation.name}`);
  if (await killSwitches.isBlocked({
    organizationId: run.organization_id,
    agentId: run.agent_definition_id,
    installationId: run.installation_id,
    toolNames: [invocation.name],
  })) throw new Error("AGENT_KILL_SWITCH_ACTIVE");

  let stepId: string | undefined;
  if (!resumeApprovedToolCall) {
    await toolInvocations.recordProposal({
      organizationId: run.organization_id,
      runId: run.id,
      providerToolCallId: invocation.id,
      sequenceNumber: 1,
      toolName: invocation.name,
      toolVersion: manifest.version,
      riskClass: manifest.riskClass,
      argumentsHash,
      arguments: invocation.arguments,
      requiresApproval: manifest.requiresApproval,
    });
    if (manifest.riskClass === "external-effect") {
      await effectReceipts.reserve({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        idempotencyKey: `${run.id}:${invocation.name}:${argumentsHash}`,
      });
    }
    const step = await runSteps.startStep({
      runId: run.id,
      organizationId: run.organization_id,
      stepType: "tool",
      input: { toolCallId: invocation.id, name: invocation.name, argumentsHash },
    });
    stepId = step.id;
    if (manifest.requiresApproval) {
      await approvals.createPending({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        resourceSnapshot: {},
        previewRevision: argumentsHash,
        policyRevision: "v1",
        permittedEffectKey: `${run.id}:${invocation.id}`,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      });
      return {
        status: "awaiting_approval" as const,
        messages: [],
        pendingToolCalls: [{ id: invocation.id, name: invocation.name, arguments: invocation.arguments, argumentsHash }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
        iterations: 0,
        toolCalls: 1,
      };
    }
  }

  try {
    if (manifest.requiresApproval) {
      await approvals.consume({
        organizationId: run.organization_id,
        runId: run.id,
        providerToolCallId: invocation.id,
        capability: invocation.name,
        capabilityVersion: manifest.version,
        argumentsHash,
        permittedEffectKey: `${run.id}:${invocation.id}`,
      });
    }
    await assertCurrentCapabilityPolicy({
      organizationId: run.organization_id,
      installationId: run.installation_id,
      name: invocation.name,
      argumentsValue: invocation.arguments,
      grantedTools,
      tools,
      installationGrants,
      approved: !manifest.requiresApproval || Boolean(resumeApprovedToolCall?.approval),
    });
    if (manifest.riskClass === "external-effect") {
      await effectReceipts.markExecutingByKey(run.organization_id, `${run.id}:${invocation.name}:${argumentsHash}`);
    }
    const result = await tools.invoke({
      name: invocation.name,
      arguments: invocation.arguments,
      grantedTools,
      approval: resumeApprovedToolCall?.approval,
      context: {
        organizationId: run.organization_id,
        agentId: run.agent_definition_id,
        agentVersionId: run.agent_version_id,
        installationId: run.installation_id,
        runId: run.id,
        actorId: run.created_by,
        correlationId: run.correlation_id,
      },
    });
    await toolInvocations.recordCompleted({
      runId: run.id,
      providerToolCallId: invocation.id,
      output: result.output,
      latencyMs: result.latencyMs,
      effectId: result.effectId,
      approval: resumeApprovedToolCall?.approval,
    });
    if (result.effectId) await effectReceipts.markSucceededByKey(run.organization_id, `${run.id}:${invocation.name}:${argumentsHash}`, result.output);
    if (stepId) await runSteps.finishStep({ stepId, status: "completed", output: { latencyMs: result.latencyMs } });
    await runs.appendEvent({
      organizationId: run.organization_id,
      runId: run.id,
      installationId: run.installation_id,
      eventType: "mcp.tool.completed",
      payload: { toolCallId: invocation.id, name: invocation.name },
    });
    return {
      status: "completed" as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 1,
    };
  } catch (error) {
    const normalized = { code: "MCP_TOOL_FAILED", message: error instanceof Error ? error.message : "MCP tool failed" };
    await toolInvocations.recordFailed({ runId: run.id, providerToolCallId: invocation.id, error: normalized });
    if (manifest.riskClass === "external-effect") {
      await effectReceipts.markFailedByKey(run.organization_id, `${run.id}:${invocation.name}:${argumentsHash}`, normalized, false);
    }
    if (stepId) await runSteps.finishStep({ stepId, status: "failed", error: normalized });
    return {
      status: "failed" as const,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 },
      iterations: 0,
      toolCalls: 1,
      error: normalized,
    };
  }
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
  approvals: ApprovalRepository,
  effectReceipts: EffectReceiptRepository,
  runSteps: RunStepRepository,
  toolGrants: ToolGrantRepository,
  installationGrants: InstallationGrantRepository,
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
    beforeToolInvoke: async (invocation) => {
      const manifest = tools.get(invocation.name);
      if (manifest?.requiresApproval && !invocation.approved) return;
      await assertCurrentCapabilityPolicy({
        organizationId: run.organization_id,
        installationId: run.installation_id,
        name: invocation.name,
        argumentsValue: invocation.arguments,
        grantedTools,
        tools,
        installationGrants,
        approved: invocation.approved,
      });
    },
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
      if (proposal.requiresApproval) {
        await approvals.createPending({
          organizationId: run.organization_id,
          installationId: run.installation_id,
          runId: run.id,
          providerToolCallId: proposal.toolCallId,
          capability: proposal.name,
          capabilityVersion: proposal.version,
          argumentsHash: proposal.argumentsHash,
          resourceSnapshot: {},
          previewRevision: proposal.argumentsHash,
          policyRevision: "v1",
          permittedEffectKey: `${run.id}:${proposal.toolCallId}`,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        });
      }
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
      if (execution.requiresApproval) {
        await approvals.consume({
          organizationId: run.organization_id,
          runId: run.id,
          providerToolCallId: execution.toolCallId,
          capability: execution.name,
          capabilityVersion: execution.version,
          argumentsHash: execution.argumentsHash,
          permittedEffectKey: `${run.id}:${execution.toolCallId}`,
        });
      }
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
