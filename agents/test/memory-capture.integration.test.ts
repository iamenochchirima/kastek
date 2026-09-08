import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { MemoryCheckpointRepository } from "../src/db/repositories/memory-checkpoint-repository";
import { MemorySourceEventRepository } from "../src/db/repositories/memory-source-event-repository";
import { createEvidenceItem, evidenceDigest } from "../src/memory/contracts";
import { createRuntimeMemoryCheckpointPort } from "../src/memory/runtime-adapter";
import { compactDurableContext, type ContextSummaryProvider } from "../src/runtime/context-compaction";
import { directEvidenceEnvelopeFromMessages, sourceEventBoundaryFromMessages } from "../src/runtime/context-memory-boundary";
import type { ModelMessage } from "../src/model/types";
import { RunRepository } from "../src/db/repositories/run-repository";
import { PostgresExecutionJournal, RunRepositoryExecutionJournalStore } from "../src/journal";
import { MemoryJournalSourceCapture, type MemoryJournalScope } from "../src/memory/journal-source-capture";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

async function deleteMemoryCaptureRows(pool: Pool, organizationId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('kasitek.actor_id', 'system:memory-deletion', true)");
    await client.query("DELETE FROM memory_checkpoints WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM memory_source_events WHERE organization_id = $1", [organizationId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe.skipIf(!runIntegration)("memory capture and checkpoint boundaries (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const conversations = new ConversationRepository(pool);
  const sources = new MemorySourceEventRepository(pool);
  const checkpoints = new MemoryCheckpointRepository(pool);
  const organizationId = `memory-capture-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const runId = randomUUID();
  const admissionRunId = randomUUID();
  const processKillRunId = randomUUID();
  let conversationId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Capture test', $3, 'test')", [agentId, organizationId, `capture-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1, $2, 1, 'test', 'test', 'test', 'published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', 'test')", [installationId, agentId, versionId, organizationId]);
    conversationId = (await conversations.createConversation({ organizationId, installationId })).id;
    await pool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'test')`,
      [runId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'test')`,
      [processKillRunId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
    );
  });

  it("deduplicates concurrent checkpoints and preserves the source boundary", async () => {
    const item = createEvidenceItem({
      id: "message-1",
      actor: "user",
      occurredAt: "2026-09-08T00:00:00.000Z",
      sourceType: "conversation_message",
      rawContent: "I prefer concise replies",
      includeContent: false,
    });
    const request = {
      runId,
      turnId: "turn-1",
      compactionGeneration: 1,
      sourceBoundary: "messages:1-1",
      idempotencyKey: "checkpoint:capture-test:1",
      scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, namespace: "conversation" as const },
      evidence: {
        contractVersion: "memory-v2" as const,
        scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, namespace: "conversation" as const },
        sourceEventIds: ["message-1"],
        items: [item],
        evidenceDigest: evidenceDigest([item]),
        redaction: "content_redacted" as const,
        capturedAt: "2026-09-08T00:00:00.000Z",
      },
    };
    const results = await Promise.all([checkpoints.commit(request), checkpoints.commit(request)]);
    expect(results.map((result) => result.status).sort()).toEqual(["committed", "replayed"]);
    expect((await pool.query("SELECT id FROM memory_checkpoints WHERE organization_id = $1 AND idempotency_key = $2", [organizationId, request.idempotencyKey])).rows).toHaveLength(1);
    expect((await pool.query("SELECT id FROM memory_source_events WHERE organization_id = $1 AND source_boundary = $2", [organizationId, request.sourceBoundary])).rows).toHaveLength(1);
    await checkpoints.markFailed({ organizationId, idempotencyKey: request.idempotencyKey, errorCode: "MEMORY_TEST_RETRY" });
    await expect(checkpoints.commit(request)).resolves.toMatchObject({ status: "replayed" });
  });

  it("keeps concurrently arriving source events ordered and replayable", async () => {
    const makeInput = (sequence: number) => {
      const item = createEvidenceItem({ id: `journal-${sequence}`, actor: "user", occurredAt: `2026-09-08T00:0${sequence}:00.000Z`, sourceType: "conversation_message", rawContent: `message ${sequence}`, includeContent: false });
      return {
        scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, runId, turnId: `turn-${sequence}`, namespace: "conversation" as const },
        eventType: "journal.conversation.message",
        sourceBoundary: `journal:${runId}:${sequence}`,
        evidence: { contractVersion: "memory-v2" as const, scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, namespace: "conversation" as const }, sourceEventIds: [item.id], items: [item], evidenceDigest: evidenceDigest([item]), redaction: "content_redacted" as const, capturedAt: item.occurredAt },
        idempotencyKey: `journal:${runId}:${sequence}`,
        eventSequence: sequence,
        occurredAt: item.occurredAt,
      };
    };
    await Promise.all([sources.record(makeInput(2)), sources.record(makeInput(1))]);
    const events = await sources.listAfter({ organizationId, runId, afterSequence: 0 });
    expect(events.map((event) => event.eventSequence)).toEqual([1, 2]);
    expect(await sources.listAfter({ organizationId, runId, afterSequence: 1 })).toHaveLength(1);
  });

  it("fences a duplicate run cursor instead of silently dropping a concurrent source event", async () => {
    const first = (sequence: number, suffix: string) => {
      const item = createEvidenceItem({ id: `fence-${suffix}`, actor: "user", occurredAt: `2026-09-08T00:1${sequence}:00.000Z`, sourceType: "conversation_message", rawContent: `fenced ${suffix}`, includeContent: false });
      return {
        scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, runId, turnId: `fence-${suffix}`, namespace: "conversation" as const },
        eventType: "journal.conversation.message",
        sourceBoundary: `fence:${suffix}`,
        evidence: { contractVersion: "memory-v2" as const, scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, namespace: "conversation" as const }, sourceEventIds: [item.id], items: [item], evidenceDigest: evidenceDigest([item]), redaction: "content_redacted" as const, capturedAt: item.occurredAt },
        idempotencyKey: `fence:${suffix}`,
        eventSequence: sequence,
        occurredAt: item.occurredAt,
      };
    };
    await expect(sources.record(first(7, "first"))).resolves.toMatchObject({ status: "created" });
    await expect(sources.record(first(7, "second"))).rejects.toMatchObject({ code: "MEMORY_SOURCE_EVENT_SEQUENCE_CONFLICT" });
    expect(await sources.listAfter({ organizationId, runId, afterSequence: 6 })).toHaveLength(1);
  });

  it("rejects an idempotency replay whose event identity changed", async () => {
    const item = createEvidenceItem({ id: "identity-1", actor: "user", occurredAt: "2026-09-08T00:20:00.000Z", sourceType: "conversation_message", rawContent: "identity", includeContent: false });
    const input = {
      scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, runId, turnId: "identity-turn", namespace: "conversation" as const },
      eventType: "journal.conversation.message",
      sourceBoundary: "identity:1",
      evidence: { contractVersion: "memory-v2" as const, scope: { organizationId, workspaceId: organizationId, agentDefinitionId: agentId, agentVersionId: versionId, installationId, conversationId, namespace: "conversation" as const }, sourceEventIds: [item.id], items: [item], evidenceDigest: evidenceDigest([item]), redaction: "content_redacted" as const, capturedAt: item.occurredAt },
      idempotencyKey: "identity:1",
      eventSequence: 20,
      occurredAt: item.occurredAt,
    };
    await expect(sources.record(input)).resolves.toMatchObject({ status: "created" });
    await expect(sources.record({ ...input, scope: { ...input.scope, turnId: "identity-turn-reused" } })).rejects.toMatchObject({ code: "MEMORY_SOURCE_EVENT_IDENTITY_CONFLICT" });
  });

  it("keeps journal evidence admitted after a checkpoint when the compaction worker loses its fence", async () => {
    const runs = new RunRepository(pool);
    await pool.query(
      `INSERT INTO agent_runs (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id, trigger_type, status, correlation_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'message','completed',$7,'test')`,
      [admissionRunId, organizationId, agentId, versionId, installationId, conversationId, randomUUID()],
    );
    const scope: MemoryJournalScope = {
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      conversationId,
      namespace: "conversation",
    };
    const capture = new MemoryJournalSourceCapture(sources, { resolve: async () => scope });
    const journal = new PostgresExecutionJournal(
      new RunRepositoryExecutionJournalStore(runs),
      [event => capture.capture(event).then(() => undefined)],
    );
    await journal.append({
      scope: { organizationId, installationId, runId: admissionRunId, operationId: "admission-before" },
      event: { kind: "run.transition", data: { to: "running" } },
    });

    const durableMessages: ModelMessage[] = [
      { role: "user", content: "The request is durable." },
      { role: "assistant", content: "I have recorded it." },
      { role: "user", content: "The work is still active." },
    ];
    let fenceChecks = 0;
    await expect(compactDurableContext({
      operationId: "admission-fence-loss",
      contextId: conversationId,
      revision: 1,
      messages: durableMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 40 },
      summaryProvider: {
        summarize: async () => {
          await journal.append({
            scope: { organizationId, installationId, runId: admissionRunId, operationId: "admission-during" },
            event: { kind: "model.completed", data: { modelCallId: "model-1", provider: "test", model: "test" } },
          });
          return { summary: "The durable request remains active." };
        },
      },
      memoryCheckpointPort: createRuntimeMemoryCheckpointPort(checkpoints),
      memoryCheckpointRequired: true,
      memoryRunId: admissionRunId,
      memoryTurnId: "admission-fence-turn",
      memoryScope: scope,
      sourceEventBoundary: sourceEventBoundaryFromMessages(durableMessages, ["message-before"]),
      directEvidence: directEvidenceEnvelopeFromMessages(durableMessages, ["message-before"]),
      assertFenceCurrent: async () => {
        fenceChecks += 1;
        if (fenceChecks === 2) throw new Error("WORKER_FENCE_LOST");
      },
    })).rejects.toMatchObject({ code: "fence_conflict" });

    const admitted = await sources.listAfter({ organizationId, runId: admissionRunId, afterSequence: 0 });
    expect(admitted.map((event) => event.eventSequence)).toEqual([1, 2]);
    const checkpointsForAdmission = await pool.query("SELECT id FROM memory_checkpoints WHERE organization_id = $1 AND run_id = $2 AND turn_id = $3", [organizationId, admissionRunId, "admission-fence-turn"]);
    expect(checkpointsForAdmission.rows).toHaveLength(1);
  });

  it("retains the pre-compaction and concurrent-arrival evidence ranges", async () => {
    const durableMessages: ModelMessage[] = [
      { role: "user", content: "The original request is durable." },
      { role: "assistant", content: "I have recorded the original request." },
      { role: "user", content: "The current task is still active." },
    ];
    const sourceEventIds = ["message-before-1", "message-before-2", "message-before-3"];
    let arrivalRecorded = false;
    const summaryProvider: ContextSummaryProvider = {
      summarize: async () => {
        // The checkpoint has already committed before summary generation. This
        // models a new inbound message arriving while compaction is running.
        if (!arrivalRecorded) {
          arrivalRecorded = true;
          durableMessages.push({ role: "user", content: "A new request arrived during compaction." });
          sourceEventIds.push("message-during-compaction");
        }
        return { summary: "Original request retained as durable history." };
      },
    };
    const checkpointPort = createRuntimeMemoryCheckpointPort(checkpoints);
    const scope = {
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      conversationId,
      namespace: "conversation" as const,
    };

    await expect(compactDurableContext({
      operationId: "arrival-compaction-before",
      contextId: conversationId,
      revision: 1,
      messages: durableMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 40 },
      summaryProvider,
      memoryCheckpointPort: checkpointPort,
      memoryCheckpointRequired: true,
      memoryRunId: runId,
      memoryTurnId: "arrival-turn-before",
      memoryScope: scope,
      sourceEventBoundary: sourceEventBoundaryFromMessages(durableMessages, sourceEventIds),
      directEvidence: directEvidenceEnvelopeFromMessages(durableMessages, sourceEventIds),
    })).resolves.toBeTruthy();

    // The second compaction sees the durable transcript after the arrival and
    // captures a strictly larger source boundary. It must not reuse the first
    // checkpoint or overwrite its evidence range.
    await expect(compactDurableContext({
      operationId: "arrival-compaction-after",
      contextId: conversationId,
      revision: 2,
      expectedGeneration: 1,
      messages: durableMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 40 },
      summaryProvider,
      memoryCheckpointPort: checkpointPort,
      memoryCheckpointRequired: true,
      memoryRunId: runId,
      memoryTurnId: "arrival-turn-after",
      memoryScope: scope,
      sourceEventBoundary: sourceEventBoundaryFromMessages(durableMessages, sourceEventIds),
      directEvidence: directEvidenceEnvelopeFromMessages(durableMessages, sourceEventIds),
    })).resolves.toBeTruthy();

    const rows = await pool.query<{ compaction_generation: number; external_event_ids: string[] }>(
      `SELECT checkpoint.compaction_generation, source.external_event_ids
         FROM memory_checkpoints checkpoint
         JOIN memory_source_events source ON source.id = checkpoint.source_event_id
        WHERE checkpoint.organization_id = $1
          AND checkpoint.run_id = $2
          AND checkpoint.turn_id IN ('arrival-turn-before', 'arrival-turn-after')
        ORDER BY checkpoint.compaction_generation ASC`,
      [organizationId, runId],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]).toMatchObject({ compaction_generation: 1, external_event_ids: ["message-before-1", "message-before-2", "message-before-3"] });
    expect(rows.rows[1]).toMatchObject({ compaction_generation: 2, external_event_ids: ["message-before-1", "message-before-2", "message-before-3", "message-during-compaction"] });
  });

  it("replays a journal event admitted before a process dies before memory observation", async () => {
    const child = fork(fileURLToPath(new URL("./fixtures/memory-journal-kill-child.ts", import.meta.url)), [], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      execArgv: ["--import", "tsx"],
      env: {
        ...process.env,
        AGENTS_DATABASE_URL: databaseUrl,
        MEMORY_KILL_ORGANIZATION_ID: organizationId,
        MEMORY_KILL_INSTALLATION_ID: installationId,
        MEMORY_KILL_RUN_ID: processKillRunId,
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });

    try {
      const [message] = await once(child, "message");
      expect(message).toMatchObject({ type: "journal-admitted", sequence: 1 });
      child.kill("SIGKILL");
      const [exitCode, signal] = await once(child, "exit");
      expect(exitCode).toBeNull();
      expect(signal).toBe("SIGKILL");
    } finally {
      if (!child.killed) child.kill("SIGKILL");
    }

    const capture = new MemoryJournalSourceCapture(sources, { resolve: async () => ({
      organizationId,
      workspaceId: organizationId,
      agentDefinitionId: agentId,
      agentVersionId: versionId,
      installationId,
      conversationId,
      namespace: "conversation" as const,
    }) });
    const journal = new PostgresExecutionJournal(new RunRepositoryExecutionJournalStore(new RunRepository(pool)));
    await expect(capture.replay({ journal, organizationId, runId: processKillRunId })).resolves.toMatchObject({ captured: 1, replayed: 0, lastSequence: 1, hasMore: false });
    await expect(capture.replay({ journal, organizationId, runId: processKillRunId, afterSequence: 0 })).resolves.toMatchObject({ captured: 0, replayed: 1, lastSequence: 1, hasMore: false });
    expect((await sources.listAfter({ organizationId, runId: processKillRunId })).map(event => event.eventSequence)).toEqual([1]);
  });

  afterAll(async () => {
    await deleteMemoryCaptureRows(pool, organizationId);
    await pool.query("DELETE FROM agent_runs WHERE id IN ($1, $2, $3)", [runId, admissionRunId, processKillRunId]);
    await pool.query("DELETE FROM conversations WHERE id = $1", [conversationId]);
    await pool.query("DELETE FROM agent_installations WHERE id = $1", [installationId]);
    await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
