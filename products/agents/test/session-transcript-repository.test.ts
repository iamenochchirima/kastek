import { describe, expect, it, vi } from "vitest";
import {
  archiveThroughSequenceForCompaction,
  SessionTranscriptRepository,
  type SessionTranscriptContext,
  type SessionTranscriptEntry,
} from "../src/db/repositories/session-transcript-repository";
import type { ModelMessage } from "../src/model/types";
import { planProviderRequest } from "../src/runtime/context-planning";

const scope = {
  organizationId: "org-context",
  installationId: "installation-context",
  conversationId: "conversation-context",
};

function databasePool() {
  let context: Record<string, unknown> | undefined;
  const entries: Array<Record<string, unknown>> = [];
  let entryNumber = 0;
  const clientQuery = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO agent_session_contexts")) {
      if (context) return { rows: [], rowCount: 0 };
      context = {
        id: "context-1",
        organization_id: scope.organizationId,
        installation_id: scope.installationId,
        conversation_id: scope.conversationId,
        session_key: values[3],
        generation: "1",
        head_sequence: "0",
        head_digest: "0".repeat(64),
        active_checkpoint_sequence: null,
        active_checkpoint_source_sequence: "0",
        active_projection_digest: "0".repeat(64),
        created_at: "2026-09-11T00:00:00.000Z",
        updated_at: "2026-09-11T00:00:00.000Z",
      };
      return { rows: [context], rowCount: 1 };
    }
    if (sql.includes("FROM agent_session_contexts")) return { rows: context ? [context] : [], rowCount: context ? 1 : 0 };
    if (sql.includes("FROM agent_session_transcript_entries") && sql.includes("idempotency_key = $2")) {
      const found = entries.find((entry) => entry.context_id === values[0] && entry.idempotency_key === values[1]);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes("SELECT sequence") && sql.includes("entry_kind = 'compaction_checkpoint'")) {
      const found = entries.filter((entry) => entry.context_id === values[0]
        && entry.generation === values[1]
        && entry.entry_kind === "compaction_checkpoint"
        && Number(entry.sequence) > Number(values[2])
        && Number(entry.sequence) <= Number(values[3]))
        .sort((left, right) => Number(left.sequence) - Number(right.sequence))
        .map((entry) => ({ sequence: entry.sequence }));
      return { rows: found, rowCount: found.length };
    }
    if (sql.includes("UPDATE agent_session_transcript_entries") && sql.includes("is_active = false")) {
      for (const entry of entries) {
        const through = Number(values[2]);
        const shouldArchive = sql.includes("generation = $2")
          ? entry.context_id === values[0] && entry.generation === values[1] && entry.is_active === true
            && (Number(entry.sequence) <= through || entry.entry_kind === "compaction_checkpoint")
          : entry.context_id === values[0] && entry.is_active === true;
        if (shouldArchive) {
          entry.is_active = false;
          entry.archived_at = "2026-09-11T00:01:00.000Z";
        }
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO agent_session_transcript_entries")) {
      const entry = {
        id: `entry-${++entryNumber}`,
        context_id: values[0],
        organization_id: values[1],
        installation_id: values[2],
        conversation_id: values[3],
        generation: values[4],
        sequence: values[5],
        turn_id: values[6],
        run_id: values[7],
        entry_kind: sql.includes("'compaction_checkpoint'") ? "compaction_checkpoint" : values[8],
        model_message: JSON.parse(String(sql.includes("'compaction_checkpoint'") ? values[8] : values[9])),
        metadata: JSON.parse(String(sql.includes("'compaction_checkpoint'") ? values[9] : values[10])),
        idempotency_key: sql.includes("'compaction_checkpoint'") ? values[10] : values[11],
        payload_digest: sql.includes("'compaction_checkpoint'") ? values[11] : values[12],
        previous_digest: sql.includes("'compaction_checkpoint'") ? values[12] : values[13],
        entry_digest: sql.includes("'compaction_checkpoint'") ? values[13] : values[14],
        is_active: sql.includes("'compaction_checkpoint'") ? true : values[15] ?? true,
        archived_at: null,
        created_at: "2026-09-11T00:00:00.000Z",
      };
      entries.push(entry);
      return { rows: [entry], rowCount: 1 };
    }
    if (sql.includes("SELECT *") && sql.includes("entry_kind = 'compaction_checkpoint'")) {
      const found = entries.find((entry) => entry.context_id === values[0]
        && entry.generation === values[1]
        && Number(entry.sequence) === Number(values[2])
        && entry.entry_kind === "compaction_checkpoint"
        && entry.is_active === true);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes("entry_kind <> 'compaction_checkpoint'") && sql.includes("is_active = true")) {
      const found = entries.filter((entry) => entry.context_id === values[0]
        && entry.generation === values[1]
        && entry.is_active === true
        && entry.entry_kind !== "compaction_checkpoint"
        && Number(entry.sequence) > Number(values[2]))
        .sort((left, right) => Number(left.sequence) - Number(right.sequence));
      return { rows: found, rowCount: found.length };
    }
    if (sql.includes("UPDATE agent_session_contexts") && sql.includes("generation = generation + 1")) {
      context = {
        ...context,
        generation: String(Number(context?.generation ?? 1) + 1),
        head_sequence: "0",
        head_digest: values[2],
        active_checkpoint_sequence: null,
        active_checkpoint_source_sequence: "0",
        active_projection_digest: values[2],
      };
      return { rows: [context], rowCount: 1 };
    }
    if (sql.includes("UPDATE agent_session_contexts")) {
      context = {
        ...context,
        head_sequence: values[3],
        head_digest: values[4],
        ...(sql.includes("active_checkpoint_sequence = $4") ? {
          active_checkpoint_sequence: values[3],
          active_checkpoint_source_sequence: values[5],
          active_projection_digest: values[6],
        } : { active_projection_digest: values[5] }),
      };
      return { rows: [context], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const client = { query: clientQuery, release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client) }, clientQuery, entries };
}

function assistantCall(): ModelMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "provider-call-1", runtimeOperationId: "runtime-call-1", name: "calendar.list", arguments: {} }],
  };
}

describe("SessionTranscriptRepository", () => {
  it("appends an ordered session transcript and replays idempotent writes", async () => {
    const { pool } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    const first = await repository.append({
      ...scope,
      turnId: "turn-1",
      kind: "user",
      message: { role: "user", content: "What is on my calendar?" },
      idempotencyKey: "message-1",
    });
    const replay = await repository.append({
      ...scope,
      turnId: "turn-1",
      kind: "user",
      message: { role: "user", content: "What is on my calendar?" },
      idempotencyKey: "message-1",
    });
    expect(first.outcome).toBe("created");
    expect(replay.outcome).toBe("replayed");
    expect(replay.entry.sequence).toBe(1);
    expect((await repository.append({
      ...scope,
      turnId: "turn-1",
      kind: "assistant_response",
      message: { role: "assistant", content: "I will check." },
      idempotencyKey: "assistant-1",
      expectedHead: { sequence: first.context.headSequence, digest: first.context.headDigest },
    })).entry.sequence).toBe(2);
    await expect(repository.append({
      ...scope,
      turnId: "turn-2",
      kind: "user",
      message: { role: "user", content: "stale" },
      idempotencyKey: "message-2",
      expectedHead: { sequence: 1, digest: first.context.headDigest },
    })).rejects.toThrow("SESSION_TRANSCRIPT_HEAD_CONFLICT");
  });

  it("reloads the canonical transcript across turns and reprojects it for a model switch", async () => {
    const { pool } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    await repository.append({
      ...scope,
      turnId: "turn-1",
      kind: "user",
      message: { role: "user", content: "Find my calendar events." },
      idempotencyKey: "turn-1-user",
    });
    await repository.append({ ...scope, turnId: "turn-1", kind: "assistant_tool_call", message: assistantCall(), idempotencyKey: "turn-1-call" });
    await repository.append({
      ...scope,
      turnId: "turn-1",
      kind: "tool_result",
      message: { role: "tool", name: "calendar.list", toolCallId: "provider-call-1", runtimeOperationId: "runtime-call-1", content: '{"events":[{"title":"Planning"}]}' },
      idempotencyKey: "turn-1-result",
    });
    await repository.append({
      ...scope,
      turnId: "turn-1",
      kind: "assistant_response",
      message: { role: "assistant", content: "You have one planning event." },
      idempotencyKey: "turn-1-final",
    });
    await repository.append({
      ...scope,
      turnId: "turn-2",
      kind: "user",
      message: { role: "user", content: "What time is it?" },
      idempotencyKey: "turn-2-user",
    });

    const projection = await repository.readActive(scope);
    const sharedPlanningInput = {
      policy: { requestedOutputTokens: 128, maxToolSchemaTokens: 500, maxToolResultTokens: 500, maxMessageUnits: 20 },
      messages: projection.messages,
      identity: {
        sourceCursor: projection.sourceCursor,
        sourceGeneration: projection.context.generation,
        sourceProjectionDigest: projection.activeProjectionDigest,
        sourceHeadDigest: projection.sourceDigest,
      },
    } as const;
    const firstModel = planProviderRequest({
      profile: { provider: "openai", model: "large-model", contextWindowTokens: 8_192, capabilitySource: "provider_metadata" },
      ...sharedPlanningInput,
    });
    const switchedModel = planProviderRequest({
      profile: { provider: "openai", model: "small-model", contextWindowTokens: 2_048, capabilitySource: "provider_metadata" },
      ...sharedPlanningInput,
    });

    expect(firstModel.status).toBe("fits");
    expect(switchedModel.status).toBe("fits");
    expect(firstModel.manifest.sourceDigest).toBe(switchedModel.manifest.sourceDigest);
    expect(switchedModel.manifest.identity).toMatchObject({ sourceCursor: 5, sourceGeneration: 1, sourceProjectionDigest: projection.activeProjectionDigest, sourceHeadDigest: projection.sourceDigest });
    expect(switchedModel.messages).toEqual(projection.messages);
    expect(switchedModel.messages).toContainEqual({ role: "tool", name: "calendar.list", toolCallId: "provider-call-1", runtimeOperationId: "runtime-call-1", content: '{"events":[{"title":"Planning"}]}' });
    expect(switchedModel.messages.at(-1)).toEqual({ role: "user", content: "What time is it?" });
  });

  it("requires an explicit recovery read for an incomplete tool round", async () => {
    const { pool } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    await repository.append({
      ...scope,
      turnId: "pending-turn",
      kind: "user",
      message: { role: "user", content: "Check my calendar." },
      idempotencyKey: "pending-user",
    });
    await repository.append({
      ...scope,
      turnId: "pending-turn",
      kind: "assistant_tool_call",
      message: assistantCall(),
      idempotencyKey: "pending-call",
    });

    await expect(repository.readActive(scope)).rejects.toThrow("SESSION_TRANSCRIPT_PROJECTION_INVALID");
    await expect(repository.readActive(scope, { allowIncomplete: true })).resolves.toMatchObject({
      messages: [
        { role: "user", content: "Check my calendar." },
        { role: "assistant", toolCalls: [{ runtimeOperationId: "runtime-call-1" }] },
      ],
    });
  });

  it("keeps an approval-waiting tool round out of the provider projection until results settle", async () => {
    const { pool } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    await repository.append({
      ...scope,
      turnId: "waiting-turn",
      kind: "user",
      message: { role: "user", content: "Check my calendar." },
      idempotencyKey: "waiting-user",
    });
    await repository.append({
      ...scope,
      turnId: "waiting-turn",
      kind: "assistant_tool_call",
      message: assistantCall(),
      idempotencyKey: "waiting-call",
    });
    await repository.append({
      ...scope,
      turnId: "waiting-turn",
      kind: "waiting",
      message: { role: "system", content: "A durable tool batch is waiting for terminal results." },
      metadata: { pendingOperationIds: ["runtime-call-1"] },
      idempotencyKey: "waiting-marker",
    });

    await expect(repository.readActive(scope)).rejects.toThrow("SESSION_TRANSCRIPT_PROJECTION_PENDING");
    const pendingProjection = await repository.readActive(scope, { allowIncomplete: true });
    expect(pendingProjection.messages).toEqual([{ role: "user", content: "Check my calendar." }]);
    expect(pendingProjection.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "assistant_tool_call" }),
      expect.objectContaining({ kind: "waiting", metadata: { pendingOperationIds: ["runtime-call-1"] } }),
    ]));

    await repository.append({
      ...scope,
      turnId: "waiting-turn",
      kind: "tool_result",
      message: {
        role: "tool",
        name: "calendar.list",
        toolCallId: "provider-call-1",
        runtimeOperationId: "runtime-call-1",
        content: '{"events":[]}',
      },
      idempotencyKey: "waiting-result",
    });
    await expect(repository.readActive(scope)).resolves.toMatchObject({
      messages: [
        { role: "user", content: "Check my calendar." },
        { role: "assistant", toolCalls: [{ runtimeOperationId: "runtime-call-1" }] },
        { role: "tool", runtimeOperationId: "runtime-call-1" },
      ],
    });
  });

  it("does not compact through an incomplete tool round", async () => {
    const { pool } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    await repository.append({
      ...scope,
      turnId: "pending-compaction-turn",
      kind: "user",
      message: { role: "user", content: "Check before compacting." },
      idempotencyKey: "pending-compaction-user",
    });
    await repository.append({
      ...scope,
      turnId: "pending-compaction-turn",
      kind: "assistant_tool_call",
      message: assistantCall(),
      idempotencyKey: "pending-compaction-call",
    });

    const projection = await repository.readActive(scope, { allowIncomplete: true });
    expect(archiveThroughSequenceForCompaction(projection, 1)).toBeUndefined();
  });

  it("stores the canonical digest when compaction activates over a waiting tail", async () => {
    const { pool } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    await repository.append({
      ...scope,
      turnId: "compaction-waiting-turn",
      kind: "user",
      message: { role: "user", content: "Check my calendar before the retry." },
      idempotencyKey: "compaction-waiting-user",
    });
    await repository.append({
      ...scope,
      turnId: "compaction-waiting-turn",
      kind: "assistant_tool_call",
      message: assistantCall(),
      idempotencyKey: "compaction-waiting-call",
    });
    await repository.append({
      ...scope,
      turnId: "compaction-waiting-turn",
      kind: "waiting",
      message: { role: "system", content: "Waiting for approval." },
      metadata: { pendingOperationIds: ["runtime-call-1"] },
      idempotencyKey: "compaction-waiting-marker",
    });

    const before = await repository.readActive(scope, { allowIncomplete: true });
    const activation = await repository.activateCompaction({
      ...scope,
      turnId: "compaction-waiting-turn",
      operationId: "compaction-waiting-operation",
      checkpointMessage: { role: "system", content: "The calendar retry is awaiting approval." },
      archiveThroughSequence: 1,
      expectedHead: { sequence: before.sourceCursor, digest: before.sourceDigest },
    });

    expect(activation.outcome).toBe("created");
    expect(activation.projection.messages).toEqual([
      { role: "system", content: "The calendar retry is awaiting approval." },
    ]);
    await expect(repository.readActive(scope)).rejects.toThrow("SESSION_TRANSCRIPT_PROJECTION_PENDING");
    await expect(repository.readActive(scope, { allowIncomplete: true })).resolves.toMatchObject({
      activeProjectionDigest: activation.projection.activeProjectionDigest,
      messages: [{ role: "system", content: "The calendar retry is awaiting approval." }],
    });
  });

  it("keeps a tool round intact when the active projection is compacted", async () => {
    const { pool, entries } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    await repository.append({ ...scope, turnId: "turn-1", kind: "user", message: { role: "user", content: "old question" }, idempotencyKey: "u-1" });
    await repository.append({ ...scope, turnId: "turn-1", kind: "assistant_response", message: { role: "assistant", content: "old answer" }, idempotencyKey: "a-1" });
    await repository.append({ ...scope, turnId: "turn-2", kind: "assistant_tool_call", message: assistantCall(), idempotencyKey: "call-1" });
    await repository.append({ ...scope, turnId: "turn-2", kind: "tool_result", message: { role: "tool", name: "calendar.list", toolCallId: "provider-call-1", runtimeOperationId: "runtime-call-1", content: '{"events":[]}' }, idempotencyKey: "result-1" });
    await repository.append({ ...scope, turnId: "turn-2", kind: "user", message: { role: "user", content: "What about tomorrow?" }, idempotencyKey: "u-2" });

    const before = await repository.readActive(scope);
    const activation = await repository.activateCompaction({
      ...scope,
      turnId: "turn-2",
      operationId: "compact-1",
      checkpointMessage: { role: "system", content: "Summary: the calendar was checked." },
      archiveThroughSequence: 2,
      expectedHead: { sequence: before.sourceCursor, digest: before.sourceDigest },
    });
    expect(activation.outcome).toBe("created");
    expect(activation.projection.messages).toEqual([
      { role: "system", content: "Summary: the calendar was checked." },
      assistantCall(),
      { role: "tool", name: "calendar.list", toolCallId: "provider-call-1", runtimeOperationId: "runtime-call-1", content: '{"events":[]}' },
      { role: "user", content: "What about tomorrow?" },
    ]);
    expect(entries.filter((entry) => entry.is_active === false)).toHaveLength(2);
    expect(activation.projection.context.activeCheckpointSequence).toBe(6);
    expect(archiveThroughSequenceForCompaction(activation.projection, 2)).toBeUndefined();

    const replay = await repository.activateCompaction({
      ...scope,
      turnId: "turn-2",
      operationId: "compact-1",
      checkpointMessage: { role: "system", content: "Summary: the calendar was checked." },
      archiveThroughSequence: 2,
      expectedHead: { sequence: activation.projection.sourceCursor, digest: activation.projection.sourceDigest },
    });
    expect(replay.outcome).toBe("replayed");
    expect(entries.filter((entry) => entry.entry_kind === "compaction_checkpoint")).toHaveLength(1);

    const beforeFailedActivation = await repository.readActive(scope);
    await expect(repository.activateCompaction({
      ...scope,
      turnId: "turn-2",
      operationId: "compact-stale",
      checkpointMessage: { role: "system", content: "stale" },
      archiveThroughSequence: 3,
      expectedHead: { sequence: beforeFailedActivation.sourceCursor - 1, digest: beforeFailedActivation.sourceDigest },
    })).rejects.toThrow("SESSION_TRANSCRIPT_HEAD_CONFLICT");
    await expect(repository.readActive(scope)).resolves.toMatchObject({ sourceCursor: beforeFailedActivation.sourceCursor, sourceDigest: beforeFailedActivation.sourceDigest });
  });

  it("keeps cursor lineage while occupancy grows, compacts, and grows again", async () => {
    const { pool } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    const observedOccupancy: number[] = [];
    const compactedOccupancy: number[] = [];
    const sourceCursors: number[] = [];
    let compactionCount = 0;

    for (let turn = 1; turn <= 18; turn += 1) {
      await repository.append({
        ...scope,
        turnId: `long-turn-${turn}`,
        kind: "user",
        message: { role: "user", content: `Long-session request ${turn}` },
        idempotencyKey: `long-turn-${turn}:user`,
      });
      await repository.append({
        ...scope,
        turnId: `long-turn-${turn}`,
        kind: "assistant_response",
        message: { role: "assistant", content: `Long-session response ${turn}` },
        idempotencyKey: `long-turn-${turn}:assistant`,
      });

      const beforeCompaction = await repository.readActive(scope);
      const bodyOccupancy = beforeCompaction.messages.filter((message) => message.role !== "system").length;
      observedOccupancy.push(bodyOccupancy);
      const archiveThroughSequence = archiveThroughSequenceForCompaction(beforeCompaction, 4);
      if (archiveThroughSequence === undefined) {
        sourceCursors.push(beforeCompaction.sourceCursor);
        continue;
      }

      const activated = await repository.activateCompaction({
        ...scope,
        turnId: `long-turn-${turn}`,
        operationId: `long-compaction-${turn}`,
        checkpointMessage: { role: "system", content: `Long-session checkpoint through turn ${turn - 1}.` },
        archiveThroughSequence,
        expectedHead: { sequence: beforeCompaction.sourceCursor, digest: beforeCompaction.sourceDigest },
      });
      compactionCount += 1;
      const activeBodyOccupancy = activated.projection.messages.filter((message) => message.role !== "system").length;
      compactedOccupancy.push(activeBodyOccupancy);
      sourceCursors.push(activated.projection.sourceCursor);
      expect(activeBodyOccupancy).toBeLessThan(bodyOccupancy);
      expect(activated.projection.context.activeCheckpointSourceSequence).toBe(archiveThroughSequence);
      expect(activated.projection.activeProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
    }

    const finalProjection = await repository.readActive(scope);
    expect(compactionCount).toBeGreaterThanOrEqual(2);
    expect(Math.max(...observedOccupancy)).toBeGreaterThan(Math.max(...compactedOccupancy));
    expect(observedOccupancy.some((occupancy) => occupancy > 4)).toBe(true);
    expect(compactedOccupancy.every((occupancy) => occupancy === 4)).toBe(true);
    expect(sourceCursors.every((cursor, index) => index === 0 || cursor > sourceCursors[index - 1]!)).toBe(true);
    expect(finalProjection.messages.some((message) => message.content === "Long-session request 18")).toBe(true);
    expect(finalProjection.context.generation).toBe(1);
  });

  it("starts a new generation without deleting the prior transcript", async () => {
    const { pool, entries } = databasePool();
    const repository = new SessionTranscriptRepository(pool as never);
    await repository.append({ ...scope, turnId: "turn-1", kind: "user", message: { role: "user", content: "old" }, idempotencyKey: "old" });
    const next = await repository.startNewGeneration({ ...scope, expectedGeneration: 1 });
    expect(next.generation).toBe(2);
    expect(next.headSequence).toBe(0);
    expect(entries[0]?.is_active).toBe(false);
    await repository.append({ ...scope, turnId: "turn-2", kind: "user", message: { role: "user", content: "new" }, idempotencyKey: "new" });
    const active = await repository.readActive(scope);
    expect(active.context.generation).toBe(2);
    expect(active.messages).toEqual([{ role: "user", content: "new" }]);
  });

  it("rejects a tampered active projection or sequence gap", async () => {
    const firstFixture = databasePool();
    const firstRepository = new SessionTranscriptRepository(firstFixture.pool as never);
    await firstRepository.append({ ...scope, turnId: "turn-1", kind: "user", message: { role: "user", content: "original" }, idempotencyKey: "u-1" });
    firstFixture.entries[0]!.model_message = { role: "user", content: "tampered" };
    await expect(firstRepository.readActive(scope)).rejects.toThrow("SESSION_TRANSCRIPT_PROJECTION_DIGEST_MISMATCH");

    const secondFixture = databasePool();
    const secondRepository = new SessionTranscriptRepository(secondFixture.pool as never);
    await secondRepository.append({ ...scope, turnId: "turn-1", kind: "user", message: { role: "user", content: "one" }, idempotencyKey: "u-1" });
    await secondRepository.append({ ...scope, turnId: "turn-1", kind: "assistant_response", message: { role: "assistant", content: "two" }, idempotencyKey: "a-1" });
    secondFixture.entries[1]!.sequence = 3;
    await expect(secondRepository.readActive(scope)).rejects.toThrow("SESSION_TRANSCRIPT_SEQUENCE_GAP");
  });
});
