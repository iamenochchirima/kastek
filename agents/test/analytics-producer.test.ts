import { describe, expect, it, vi } from "vitest";
import {
  AnalyticsIngestionClient,
  AnalyticsProducerValidationError,
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
