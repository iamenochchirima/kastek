import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsIngestionClient,
  AnalyticsProducerValidationError,
  buildApprovalLifecycleEvent,
  buildCompletedAgentRunEvent,
  buildCompletedModelCallEvent,
  buildEffectLifecycleEvent,
  buildFailedAgentRunEvent,
  buildFailedModelCallEvent,
  buildInstallationLifecycleEvent,
  buildReadinessSnapshotEvent,
  buildScheduleLifecycleEvent,
  buildToolInvocationLifecycleEvent,
  buildVersionLifecycleEvent,
  buildEvent,
  buildObservation,
  buildScopeDefinition,
  canonicalJsonSha256,
  isRegisteredAgentContract,
  type AgentOutboxRow,
  type EventInput,
} from "../src/analytics";
import { RetryPolicy } from "../src/analytics/publisher";

function event(overrides: Partial<EventInput> = {}): EventInput {
  return {
    recordId: "run-1-completed",
    sourceDomain: "agents",
    sourceStreamKey: "agent:org-1",
    contractName: "agent.run.completed@1",
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: "org-1",
    subject: "run/run-1",
    occurredAt: "2026-08-22T10:00:00.000Z",
    attributes: {
      run_id: "run-1",
      installation_id: "installation-1",
      agent_definition_id: "agent-1",
      status: "completed",
      occurred_at: "2026-08-22T10:00:00.000Z",
    },
    ...overrides,
  };
}

describe("Agent analytics producer", () => {
  it("builds terminal runtime facts with safe conditional-agent metadata", () => {
    const completed = buildCompletedAgentRunEvent({
      runId: "run-completed",
      organizationId: "org-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      installationId: "installation-1",
      conversationId: "conversation-1",
      triggerType: "message",
      executionMode: "kasitek_hosted",
      creationProfile: "custom",
      agentAudience: "customer_service",
      input: { message: "not copied" },
      correlationId: "correlation-1",
      causationId: null,
      createdAt: "2026-08-22T09:59:00.000Z",
      startedAt: "2026-08-22T09:59:30.000Z",
      finishedAt: "2026-08-22T10:00:00.000Z",
      output: { outcome: "partial", message: "private response" },
    });
    expect(completed.envelope.data).toMatchObject({
      status: "completed",
      outcome: "partial",
      trigger_type: "message",
      execution_mode: "kasitek_hosted",
      creation_profile: "custom",
      agent_audience: "customer_service",
      deployment_surface: "conversation",
      duration_ms: 30_000,
    });
    expect(completed.envelope.data).not.toHaveProperty("message");
    expect(completed.idempotencyKey).toBe("agent-platform:run:run-completed:completed");

    const failed = buildFailedAgentRunEvent({
      runId: "run-failed",
      organizationId: "org-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      installationId: "installation-1",
      conversationId: null,
      triggerType: "schedule",
      executionMode: "kasitek_hosted",
      creationProfile: "general",
      agentAudience: "personal",
      input: { mcpTool: { name: "external" } },
      correlationId: "correlation-2",
      causationId: null,
      createdAt: "2026-08-22T10:00:00.000Z",
      startedAt: "2026-08-22T10:00:01.000Z",
      finishedAt: "2026-08-22T10:00:03.000Z",
      error: { code: "MODEL_TIMEOUT", message: "private provider detail" },
    });
    expect(failed.envelope.data).toMatchObject({
      status: "failed",
      failure_class: "timeout",
      deployment_surface: "external_operation",
      duration_ms: 2_000,
    });
    expect(JSON.stringify(failed.envelope.data)).not.toContain("private provider detail");
  });

  it("builds model-call facts with usage dimensions and no provider payload", () => {
    const completed = buildCompletedModelCallEvent({
      modelCallId: "model-call-completed",
      organizationId: "org-1",
      runId: "run-1",
      provider: "openai",
      model: "gpt-test",
      fundingSource: "kasitek",
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      estimatedCostUsd: 0.0042,
      latencyMs: 275,
      finishReason: "stop",
      occurredAt: "2026-08-22T10:00:00.000Z",
      correlationId: "correlation-1",
    });
    expect(completed.envelope.data).toMatchObject({
      model_call_id: "model-call-completed",
      run_id: "run-1",
      provider: "openai",
      model: "gpt-test",
      funding_source: "kasitek",
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
      estimated_cost_usd: 0.0042,
      latency_ms: 275,
      finish_reason: "stop",
      status: "completed",
    });
    expect(completed.envelope).toMatchObject({
      type: "agent.model_call.completed@1",
      subject: "model-call:model-call-completed",
      correlation_id: "correlation-1",
    });
    expect(JSON.stringify(completed.envelope)).not.toContain("credential");
    expect(JSON.stringify(completed.envelope)).not.toContain("prompt");

    const failed = buildFailedModelCallEvent({
      modelCallId: "model-call-failed",
      organizationId: "org-1",
      runId: "run-1",
      provider: "anthropic",
      model: "claude-test",
      fundingSource: "user",
      occurredAt: "2026-08-22T10:01:00.000Z",
      error: { code: "PROVIDER_RATE_LIMITED", message: "private provider response" },
    });
    expect(failed.envelope.data).toMatchObject({
      model_call_id: "model-call-failed",
      provider: "anthropic",
      model: "claude-test",
      funding_source: "user",
      failure_class: "provider",
      status: "failed",
    });
    expect(JSON.stringify(failed.envelope)).not.toContain("private provider response");
  });

  it("builds a registered envelope and hashes canonical payload JSON", () => {
    const record = buildEvent(event({ attributes: { b: 2, a: 1 } }));
    expect(isRegisteredAgentContract(record.contractName)).toBe(true);
    expect(record.envelope).toMatchObject({
      specversion: "1.0",
      source_service: "agent-platform",
      record_category: "event",
      idempotency_key: "run-1-completed",
      dataschema: "https://kasitek.co.za/analytics/contracts/events/agent/run_completed/v1.schema.json",
    });
    expect(record.payloadHash).toBe(canonicalJsonSha256({ a: 1, b: 2 }));
  });

  it("builds tool, approval, and effect lifecycle facts without operational payloads", () => {
    const common = {
      organizationId: "org-1",
      runId: "run-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      installationId: "installation-1",
      correlationId: "correlation-1",
    };
    const tool = buildToolInvocationLifecycleEvent({
      ...common,
      toolInvocationId: "tool-1",
      providerToolCallId: "provider-call-1",
      toolName: "content.publish",
      toolVersion: "1.0.0",
      riskClass: "external-effect",
      action: "failed",
      status: "failed",
      sequenceNumber: 2,
      requiresApproval: true,
      latencyMs: 100,
      effectId: "effect-1",
      failureClass: "provider",
      occurredAt: "2026-08-22T10:00:00.000Z",
    });
    expect(tool.envelope.data).toMatchObject({
      action: "failed",
      status: "failed",
      tool_name: "content.publish",
      risk_class: "external-effect",
      failure_class: "provider",
    });
    expect(JSON.stringify(tool.envelope)).not.toContain("arguments");
    expect(JSON.stringify(tool.envelope)).not.toContain("output");

    const approval = buildApprovalLifecycleEvent({
      ...common,
      approvalId: "approval-1",
      providerToolCallId: "provider-call-1",
      capability: "content.publish",
      capabilityVersion: "1.0.0",
      action: "approved",
      status: "approved",
      actorType: "human",
      actorRef: "member-1",
      expiresAt: "2026-08-22T10:30:00.000Z",
      occurredAt: "2026-08-22T10:01:00.000Z",
    });
    expect(approval.envelope.data).toMatchObject({ action: "approved", status: "approved", actor_type: "human" });
    expect(JSON.stringify(approval.envelope)).not.toContain("resource_snapshot");

    const effect = buildEffectLifecycleEvent({
      ...common,
      effectId: "effect-1",
      providerToolCallId: "provider-call-1",
      capability: "content.publish",
      capabilityVersion: "1.0.0",
      action: "unknown",
      status: "unknown",
      reconciliationRequired: true,
      failureClass: "provider",
      occurredAt: "2026-08-22T10:02:00.000Z",
      completedAt: null,
    });
    expect(effect.envelope.data).toMatchObject({ action: "unknown", status: "unknown", reconciliation_required: true });
    expect(JSON.stringify(effect.envelope)).not.toContain("provider_receipt");
    expect(JSON.stringify(effect.envelope)).not.toContain("PROVIDER_OUTCOME_UNKNOWN");
  });

  it("registers the handoff lifecycle contract without carrying transcript content", () => {
    const record = buildEvent(event({
      recordId: "handoff-1-requested",
      contractName: "agent.handoff.lifecycle@1",
      subject: "handoff/handoff-1",
      idempotencyKey: "handoff-1-requested",
      attributes: {
        handoff_id: "handoff-1",
        conversation_id: "conversation-1",
        installation_id: "installation-1",
        agent_definition_id: "agent-1",
        agent_version_id: "version-1",
        run_id: "run-1",
        channel_type: "platform",
        action: "requested",
        status: "pending",
        reason: "customer_requested",
        priority: "normal",
        actor_type: "agent",
        conversation_state: "handoff_requested",
        occurred_at: "2026-08-22T10:00:00.000Z",
      },
    }));
    expect(isRegisteredAgentContract(record.contractName)).toBe(true);
    expect(record.envelope.dataschema).toBe("https://kasitek.co.za/analytics/contracts/events/agent/handoff_lifecycle/v1.schema.json");
    expect(record.envelope.data).not.toHaveProperty("customer_message");
  });

  it("builds schedule lifecycle facts without schedule input", () => {
    const record = buildScheduleLifecycleEvent({
      scheduleId: "schedule-1",
      organizationId: "org-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      installationId: "installation-1",
      action: "paused",
      status: "paused",
      previousStatus: "active",
      timezone: "Africa/Johannesburg",
      nextRunAt: "2026-08-23T06:00:00.000Z",
      actorType: "human",
      occurredAt: "2026-08-22T10:03:00.000Z",
    });
    expect(record.envelope).toMatchObject({
      type: "agent.schedule.lifecycle@1",
      subject: "schedule:schedule-1",
      dataschema: "https://kasitek.co.za/analytics/contracts/events/agent/schedule_lifecycle/v1.schema.json",
    });
    expect(record.envelope.data).toMatchObject({
      action: "paused",
      status: "paused",
      previous_status: "active",
      actor_type: "human",
    });
    expect(JSON.stringify(record.envelope)).not.toContain("prompt");
    expect(JSON.stringify(record.envelope)).not.toContain("expression");
  });

  it("builds installation lifecycle facts with agent category boundaries", () => {
    const record = buildInstallationLifecycleEvent({
      installationId: "installation-1",
      organizationId: "org-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      executionMode: "kasitek_hosted",
      creationProfile: "custom",
      agentAudience: "customer_service",
      scopeType: "organization",
      action: "paused",
      status: "paused",
      previousStatus: "active",
      actorType: "human",
      occurredAt: "2026-08-22T10:03:30.000Z",
    });
    expect(record.envelope).toMatchObject({
      type: "agent.installation.lifecycle@1",
      subject: "installation:installation-1",
      dataschema: "https://kasitek.co.za/analytics/contracts/events/agent/installation_lifecycle/v1.schema.json",
    });
    expect(record.envelope.data).toMatchObject({
      execution_mode: "kasitek_hosted",
      creation_profile: "custom",
      agent_audience: "customer_service",
      scope_type: "organization",
      action: "paused",
      previous_status: "active",
    });
    expect(JSON.stringify(record.envelope)).not.toContain("settings");
    expect(JSON.stringify(record.envelope)).not.toContain("prompt");
  });

  it("builds version lifecycle facts without version content", () => {
    const record = buildVersionLifecycleEvent({
      organizationId: "org-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-2",
      versionNumber: 2,
      status: "published",
      action: "rolled_back",
      actorType: "human",
      occurredAt: "2026-08-22T10:04:00.000Z",
    });
    expect(record.envelope).toMatchObject({
      type: "agent.version.lifecycle@1",
      subject: "version:version-2",
      dataschema: "https://kasitek.co.za/analytics/contracts/events/agent/version_lifecycle/v1.schema.json",
    });
    expect(record.envelope.data).toMatchObject({
      version_number: 2,
      status: "published",
      action: "rolled_back",
      actor_type: "human",
    });
    expect(JSON.stringify(record.envelope)).not.toContain("instructions");
    expect(JSON.stringify(record.envelope)).not.toContain("configuration");
  });

  it("builds readiness snapshots from bounded state fields", () => {
    const record = buildReadinessSnapshotEvent({
      organizationId: "org-1",
      installationId: "installation-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-1",
      executionMode: "kasitek_hosted",
      status: "blocked",
      workflowStatus: "ready",
      credentialStatus: "ready",
      blockerCodes: ["connection_not_configured"],
      requiredCapabilityCount: 3,
      missingCapabilityCount: 0,
      requiredConnectionCount: 1,
      missingConnectionCount: 1,
      evaluationSource: "readiness_route",
      observedAt: "2026-08-22T10:04:00.000Z",
    });
    expect(record.envelope).toMatchObject({
      type: "agent.readiness.snapshot@1",
      subject: "installation:installation-1",
      dataschema: "https://kasitek.co.za/analytics/contracts/events/agent/readiness_snapshot/v1.schema.json",
    });
    expect(record.envelope.data).toMatchObject({
      status: "blocked",
      workflow_status: "ready",
      credential_status: "ready",
      blocker_set: "connection_not_configured",
      blocker_count: 1,
      missing_connection_count: 1,
      evaluation_source: "readiness_route",
    });
    expect(record.envelope.data.state_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(record.envelope)).not.toContain("detail");
    expect(JSON.stringify(record.envelope)).not.toContain("credential_reference");
  });

  it("rejects prohibited content before a database call", () => {
    expect(() => buildEvent(event({ attributes: { response: "private model output" } }))).toThrowError(
      new AnalyticsProducerValidationError("prohibited_field", "Analytics payload contains prohibited field response"),
    );
  });

  it("builds observation and scope-definition records with their boundaries", () => {
    const observation = buildObservation({
      recordId: "provider-1",
      sourceDomain: "agents",
      sourceStreamKey: "agent:org-1",
      contractName: "agent.provider.usage@1",
      schemaVersion: 1,
      scopeKind: "core_organization",
      scopeExternalId: "org-1",
      provider: "openai",
      metricKey: "tokens",
      numericValue: 42,
      unit: "tokens",
      reportingWindowStart: "2026-08-22T09:00:00.000Z",
      reportingWindowEnd: "2026-08-22T10:00:00.000Z",
      observedAt: "2026-08-22T10:00:00.000Z",
      synchronizationRunId: "sync-1",
      dimensions: { model: "gpt" },
      sourceEvidence: { provider_request_id: "request-1" },
    });
    expect(observation.recordCategory).toBe("observation");
    expect(observation.envelope.data.numeric_value).toBe(42);

    const scope = buildScopeDefinition({
      recordId: "org-1-v1",
      sourceDomain: "organizations",
      sourceStreamKey: "agent:scopes",
      contractName: "agent.scope.organization@1",
      schemaVersion: 1,
      scopeKind: "core_organization",
      scopeExternalId: "org-1",
      reportingTimezone: "Africa/Johannesburg",
      status: "active",
      sourceVersion: 1,
    });
    expect(scope.recordCategory).toBe("scope_definition");
    expect(scope.envelope.subject).toBe("scope:org-1");
  });

  it("rejects an invalid observation window", () => {
    expect(() => buildObservation({
      recordId: "provider-1",
      sourceDomain: "agents",
      sourceStreamKey: "agent:org-1",
      contractName: "agent.provider.usage@1",
      schemaVersion: 1,
      scopeKind: "core_organization",
      scopeExternalId: "org-1",
      provider: "openai",
      metricKey: "tokens",
      numericValue: 42,
      unit: "tokens",
      reportingWindowStart: "2026-08-22T10:00:00.000Z",
      reportingWindowEnd: "2026-08-22T09:00:00.000Z",
      observedAt: "2026-08-22T10:00:00.000Z",
      synchronizationRunId: "sync-1",
      dimensions: {},
      sourceEvidence: {},
    })).toThrow(/reportingWindowEnd must be after reportingWindowStart/);
  });

  it("uses deterministic capped retry jitter", () => {
    const policy = new RetryPolicy();
    const now = new Date("2026-08-22T10:00:00.000Z");
    expect(policy.nextRetryAt(now, 1, "outbox-1").getTime()).toBe(policy.nextRetryAt(now, 1, "outbox-1").getTime());
    expect(policy.nextRetryAt(now, 99, "outbox-1").getTime()).toBeLessThanOrEqual(now.getTime() + 302_000);
  });

  it("posts an authenticated batch using the Analytics wire contract", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:4300/internal/ingest/v1/batch");
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-token", "content-type": "application/json" });
      const body = JSON.parse(String(init?.body)) as { records: Array<Record<string, unknown>> };
      expect(body.records[0]).toMatchObject({
        producer_id: "agent-platform-customer-analytics",
        source_sequence: 7,
        record_id: "transport-record",
      });
      return new Response(JSON.stringify({
        acknowledgements: [{ record_id: "transport-record", source_sequence: 7, status: "accepted" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const row: AgentOutboxRow = {
        outboxId: "outbox-transport",
        sourceSequence: "7",
        sourceService: "agent-platform",
        sourceDomain: "agents",
        sourceStreamKey: "agent:org-1",
        recordCategory: "event",
        recordId: "transport-record",
        contractName: "agent.run.completed@1",
        schemaVersion: 1,
        scopeKind: "core_organization",
        scopeExternalId: "org-1",
        idempotencyKey: "transport-record",
        envelope: {} as AgentOutboxRow["envelope"],
        payloadHash: "hash",
        deliveryStatus: "leased",
        attemptCount: 1,
        nextAttemptAt: new Date(),
        leaseOwner: "publisher",
        leaseExpiresAt: new Date(),
      };
      const client = new AnalyticsIngestionClient({ endpoint: "http://127.0.0.1:4300", token: "test-token", requestTimeoutMs: 2_000 });
      const response = await client.sendBatch("agent-platform-customer-analytics", [row]);
      expect(response.acknowledgements[0]?.status).toBe("accepted");
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
