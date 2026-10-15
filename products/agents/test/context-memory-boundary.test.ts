import { describe, expect, it } from "vitest";
import { ModelGateway } from "../src/model/gateway";
import type { ModelCredentials, ModelMessage, ModelRequest } from "../src/model/types";
import { ToolRegistry } from "../src/tools/registry";
import {
  directEvidenceEnvelopeFromMessages,
  noopMemoryCheckpointPort,
  noopMemoryRetrievalPort,
  sourceEventBoundaryFromMessages,
  type MemoryCheckpointPort,
  type MemoryCheckpointRequest,
  type MemoryRetrievalPort,
} from "../src/runtime/context-memory-boundary";
import { compactDurableContext, type DurableContextAdapter, type DurableContextRecord } from "../src/runtime/context-compaction";
import { planProviderRequest, type ContextRequestManifest } from "../src/runtime/context-planning";
import { runBoundedAgentLoop } from "../src/runtime/loop";

const credentials: ModelCredentials = { apiKey: "test", fundingSource: "kasitek" };
const messages: ModelMessage[] = [
  { role: "system", content: "policy" },
  { role: "user", content: "older durable evidence" },
  { role: "user", content: "current task" },
];

describe("context and memory integration boundary", () => {
  it("passes a redacted, idempotent checkpoint request before lossy compaction", async () => {
    const requests: MemoryCheckpointRequest[] = [];
    const seen = new Set<string>();
    const checkpointPort: MemoryCheckpointPort = {
      async checkpoint(request) {
        requests.push(request);
        const replayed = seen.has(request.evidenceDigest);
        seen.add(request.evidenceDigest);
        return { status: replayed ? "replayed" : "committed", checkpointId: "checkpoint-1" };
      },
    };
    const first = await compactDurableContext({
      operationId: "memory-compaction-1",
      contextId: "conversation-1",
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      memoryCheckpointPort: checkpointPort,
      memoryCheckpointRequired: true,
      memoryRunId: "run-1",
      memoryTurnId: "turn-1",
      memoryScope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" },
      sourceEventBoundary: { eventIds: ["event-1", "event-2"], digest: "source-boundary-1" },
      evidenceDigest: "runtime-evidence-digest",
      directEvidence: directEvidenceEnvelopeFromMessages(messages, ["event-1", "event-2", "event-3"]),
    });

    expect(first.messages).toHaveLength(3);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      runId: "run-1",
      turnId: "turn-1",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: ["event-1", "event-2"], digest: "source-boundary-1" },
      evidenceDigest: "runtime-evidence-digest",
      directEvidence: { schemaVersion: "v1", redacted: true },
    });
    expect(requests[0]?.directEvidence.items[0]).not.toHaveProperty("redactedContent");
  });

  it("replays after a worker is lost after memory checkpoint and before context projection", async () => {
    const checkpointStatuses: string[] = [];
    const checkpointKeys = new Set<string>();
    const records = new Map<string, DurableContextRecord>();
    let persistAttempts = 0;
    const checkpointPort: MemoryCheckpointPort = {
      async checkpoint(request) {
        const replayed = checkpointKeys.has(request.idempotencyKey);
        checkpointKeys.add(request.idempotencyKey);
        checkpointStatuses.push(replayed ? "replayed" : "committed");
        return { status: replayed ? "replayed" : "committed", checkpointId: "checkpoint-worker-loss" };
      },
    };
    const adapter: DurableContextAdapter = {
      read: async (operationId) => records.get(operationId),
      readLatest: async (contextId) => Math.max(0, ...[...records.values()]
        .filter((record) => record.compaction.contextId === contextId)
        .map((record) => record.compaction.generation)),
      persist: async (input) => {
        persistAttempts += 1;
        if (persistAttempts === 1) throw new Error("WORKER_LOST_AFTER_MEMORY_CHECKPOINT");
        const record = { decision: input.decision, compaction: input.compaction };
        records.set(input.decision.operationId, record);
        return { status: "created" as const, record };
      },
    };
    const input = {
      operationId: "memory-worker-loss-after-checkpoint",
      contextId: "conversation-1",
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter,
      memoryCheckpointPort: checkpointPort,
      memoryCheckpointRequired: true,
      memoryRunId: "run-1",
      memoryTurnId: "turn-1",
      memoryScope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" as const },
    } as const;

    await expect(compactDurableContext(input)).rejects.toMatchObject({ code: "persistence_failed" });
    const replay = await compactDurableContext(input);

    expect(checkpointStatuses).toEqual(["committed", "replayed"]);
    expect(persistAttempts).toBe(2);
    expect(replay.diagnostics.replayed).toBe(false);
    expect(records).toHaveProperty("size", 1);
  });

  it("blocks compaction when checkpoint enforcement is enabled and the port fails", async () => {
    const events: string[] = [];
    let durableProjectionAttempted = false;
    const checkpointPort: MemoryCheckpointPort = {
      checkpoint: async () => { throw new Error("memory store unavailable"); },
    };
    await expect(compactDurableContext({
      operationId: "memory-compaction-blocked",
      contextId: "conversation-1",
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      memoryCheckpointPort: checkpointPort,
      memoryCheckpointRequired: true,
      memoryScope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" },
      adapter: {
        read: async () => undefined,
        persist: async () => {
          durableProjectionAttempted = true;
          throw new Error("must not persist after checkpoint failure");
        },
      },
      onMemoryEvent: (event) => { events.push(event.type); },
    })).rejects.toMatchObject({ code: "memory_checkpoint_blocked" });
    expect(events).toEqual([
      "memory_checkpoint_requested",
      "memory_checkpoint_failed",
      "memory_checkpoint_blocked",
    ]);
    expect(durableProjectionAttempted).toBe(false);
  });

  it("injects retrieved evidence before the final manifest and keeps memory outside context policy", async () => {
    const requests: ModelRequest[] = [];
    const events: string[] = [];
    const manifests: ContextRequestManifest[] = [];
    const callbackOrder: string[] = [];
    const retrievalPort: MemoryRetrievalPort = {
      async retrieve(request) {
        callbackOrder.push("retrieval");
        expect(request).toMatchObject({
          runId: "run-1",
          turnId: "run-1",
          attemptId: "model:1:memory",
          compactionGeneration: 0,
          sourceEventBoundary: { digest: expect.any(String) },
          reason: "preference_reference",
          query: "What is my usual style?",
          scope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" },
        });
        return {
          packId: "pack-1",
          status: "completed",
          evidence: [{
            evidenceId: "evidence-1",
            scope: request.scope,
            provenance: { sourceEventIds: ["event-1"] },
            validity: {},
            lifecycleState: "active",
            retrievalReason: request.reason,
            score: 0.9,
            redactedContent: "The user's preferred reply style is concise.",
          }],
        };
      },
    };
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "system", content: "policy" }, { role: "user", content: "What is my usual style?" }],
      credentials,
      gateway: new ModelGateway([{
        provider: "openai",
        capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
        complete: async (request) => {
          callbackOrder.push("provider");
          requests.push(request);
          return { provider: "openai", model: request.model, message: { role: "assistant", content: "Concise." }, toolCalls: [], finishReason: "stop", usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 }, latencyMs: 1 };
        },
      }]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org-1", agentId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", runId: "run-1", correlationId: "corr-1", scope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", runId: "run-1", correlationId: "corr-1", capabilityGrants: [] } },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 1_000, maxOutputTokens: 64, capabilitySource: "configured_override" },
      memoryRetrievalPort: retrievalPort,
      memoryScope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" },
      memoryRetrievalQuery: "What is my usual style?",
      memoryRetrievalReason: "preference_reference",
      persistContextManifest: ({ manifest }) => {
        callbackOrder.push("manifest");
        manifests.push(manifest);
      },
      onEvent: (event) => events.push(event.type),
    });

    expect(result.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("evidence-1");
    expect(events).toEqual(expect.arrayContaining(["memory_retrieval_requested", "memory_retrieval_completed"]));
    expect(events.indexOf("memory_retrieval_completed")).toBeLessThan(events.indexOf("context.planned"));
    expect(callbackOrder).toEqual(["retrieval", "manifest", "provider"]);
    expect(manifests).toHaveLength(1);

    const manifest = manifests[0]!;
    const systemComponent = manifest.components.find((component) => component.kind === "system");
    expect(systemComponent).toMatchObject({ selectedCount: 2, estimatedTokens: expect.any(Number) });
    expect(systemComponent?.estimatedBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify([{ role: "system", content: "policy" }]), "utf8"));
    expect(manifest.estimatedInputTokens).toBe(
      manifest.components.reduce((total, component) => total + component.estimatedTokens, 0),
    );

    const baseline = planProviderRequest({
      profile: { provider: "openai", model: "test-model", contextWindowTokens: 1_000, maxOutputTokens: 64 },
      policy: { requestedOutputTokens: 64, maxToolSchemaTokens: 2_000, maxToolResultTokens: 1_500 },
      messages: [{ role: "system", content: "policy" }, { role: "user", content: "What is my usual style?" }],
    });
    expect(manifest.estimatedInputTokens).toBeGreaterThan(baseline.accounting.estimatedInputTokens);
    expect(systemComponent!.estimatedTokens).toBeGreaterThan(
      baseline.manifest.components.find((component) => component.kind === "system")!.estimatedTokens,
    );
  });

  it("preserves a typed memory policy block instead of returning a generic loop failure", async () => {
    const events: string[] = [];
    let modelCalls = 0;
    const result = await runBoundedAgentLoop({
      model: { provider: "openai", model: "test-model" },
      messages: [{ role: "system", content: "policy" }, { role: "user", content: "Use my saved preference." }],
      credentials,
      gateway: new ModelGateway([{
        provider: "openai",
        capabilities: { toolCalling: true, structuredOutput: true, streaming: false, vision: false },
        complete: async (request) => {
          modelCalls += 1;
          return { provider: "openai", model: request.model, message: { role: "assistant", content: "Should not run." }, toolCalls: [], finishReason: "stop", usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 }, latencyMs: 1 };
        },
      }]),
      tools: new ToolRegistry(),
      toolContext: { organizationId: "org-1", agentId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", runId: "run-1", correlationId: "corr-1", scope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", runId: "run-1", correlationId: "corr-1", capabilityGrants: [] } },
      grantedTools: new Set(),
      contextProfile: { provider: "openai", model: "test-model", contextWindowTokens: 1_000, maxOutputTokens: 64, capabilitySource: "configured_override" },
      memoryRetrievalPort: {
        async retrieve(request) {
          return { packId: `blocked:${request.turnId}`, status: "blocked", evidence: [], blockedReason: "MEMORY_SCOPE_BLOCKED" };
        },
      },
      memoryScope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" },
      memoryRetrievalQuery: "Use my saved preference.",
      memoryRetrievalReason: "preference_reference",
      onEvent: (event) => events.push(event.type),
    });

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({ code: "MEMORY_RETRIEVAL_BLOCKED" });
    expect(modelCalls).toBe(0);
    expect(events.slice(-4)).toEqual(["memory_retrieval_requested", "memory_retrieval_blocked", "memory_retrieval_blocked", "loop.failed"]);
  });

  it("records a missing checkpoint scope as failed and blocked when enforcement is on", async () => {
    const events: string[] = [];
    await expect(compactDurableContext({
      operationId: "memory-scope-blocked",
      contextId: "conversation-1",
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      memoryCheckpointPort: noopMemoryCheckpointPort,
      memoryCheckpointRequired: true,
      onMemoryEvent: (event) => { events.push(event.type); },
    })).rejects.toMatchObject({ code: "memory_checkpoint_blocked" });
    expect(events).toEqual([
      "memory_checkpoint_requested",
      "memory_checkpoint_failed",
      "memory_checkpoint_blocked",
    ]);
  });

  it("provides inert adapters for parallel context tests", async () => {
    await expect(noopMemoryRetrievalPort.retrieve({
      runId: "run-1",
      turnId: "turn-1",
      attemptId: "attempt-1",
      compactionGeneration: 0,
      sourceEventBoundary: { eventIds: [], digest: "digest" },
      scope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" },
      reason: "test",
      query: "test",
    })).resolves.toMatchObject({ status: "completed", evidence: [] });
    await expect(noopMemoryCheckpointPort.checkpoint({
      runId: "run-1",
      turnId: "turn-1",
      compactionGeneration: 1,
      sourceEventBoundary: { eventIds: [], digest: "digest" },
      scope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "conversation" },
      evidenceDigest: "evidence",
      directEvidence: directEvidenceEnvelopeFromMessages([]),
    })).resolves.toMatchObject({ status: "committed" });
  });

  it("keeps injected evidence out of the next durable retrieval boundary", () => {
    const sourceMessages: ModelMessage[] = [
      { role: "system", content: "policy" },
      { role: "user", content: "What is my usual style?" },
    ];
    const withEvidence = [
      ...sourceMessages.slice(0, 1),
      { role: "system" as const, content: '<untrusted-data source="memory-evidence">\n[evidence-1] concise\n</untrusted-data>' },
      ...sourceMessages.slice(1),
    ];

    expect(sourceEventBoundaryFromMessages(withEvidence, ["event-1"]).digest)
      .toBe(sourceEventBoundaryFromMessages(sourceMessages, ["event-1"]).digest);
    expect(directEvidenceEnvelopeFromMessages(withEvidence, ["event-1", "event-injected", "event-2"]).items)
      .toHaveLength(1);
    expect(directEvidenceEnvelopeFromMessages(withEvidence, ["event-1", "event-injected", "event-2"]).items[0]?.sourceEventId)
      .toBe("event-2");
  });

  it("keeps tool payloads and assistant tool envelopes out of direct evidence", () => {
    const envelope = directEvidenceEnvelopeFromMessages([
      { role: "system", content: "runtime policy" },
      { role: "user", content: "Please check availability" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "check_availability", arguments: {} }] },
      { role: "tool", content: "booking payload", toolCallId: "call-1" },
      { role: "assistant", content: "There is availability on Friday." },
    ], ["system", "user", "call", "tool", "assistant"]);
    expect(envelope.items.map((item) => item.sourceEventId)).toEqual(["user", "assistant"]);
    expect(envelope.items.every((item) => item.role === "user" || item.role === "assistant")).toBe(true);
  });
});
