import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import {
  archiveThroughSequenceForCompaction,
  SessionTranscriptRepository,
  type SessionTranscriptScope,
} from "../src/db/repositories/session-transcript-repository";
import { SessionLeaseRepository } from "../src/db/repositories/session-lease-repository";
import type { ModelMessage } from "../src/model/types";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("session transcript PostgreSQL durability (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const conversations = new ConversationRepository(pool);
  const transcripts = new SessionTranscriptRepository(pool);
  const leases = new SessionLeaseRepository(pool);
  const organizationId = `session-transcript-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  const createdConversationIds: string[] = [];

  beforeAll(async () => {
    await pool.query(
      "INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Session transcript integration', $3, 'test')",
      [agentId, organizationId, `session-transcript-${agentId}`],
    );
    await pool.query(
      "INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1, $2, 1, 'test', 'session-transcript-test', 'test', 'published')",
      [versionId, agentId],
    );
    await pool.query(
      `INSERT INTO agent_installations
        (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, execution_mode, created_by)
       VALUES ($1, $2, $3, $4, 'organization', $4, 'kasitek_hosted', 'test')`,
      [installationId, agentId, versionId, organizationId],
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM agent_session_transcript_entries WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_session_contexts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_session_leases WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });

  async function createScope(): Promise<SessionTranscriptScope> {
    const conversation = await conversations.createConversation({
      organizationId,
      installationId,
      conversationKind: "personal",
    });
    createdConversationIds.push(conversation.id);
    return { organizationId, installationId, conversationId: conversation.id };
  }

  function assistantCall(runtimeOperationId = "runtime-call-1"): ModelMessage {
    return {
      role: "assistant",
      content: "",
      toolCalls: [{
        id: "provider-call-1",
        runtimeOperationId,
        name: "calendar.list",
        arguments: { range: "today" },
      }],
    };
  }

  it("reloads ordered turns, activates compaction, replays safely, and resets generations", async () => {
    const scope = await createScope();
    const first = await transcripts.readActive(scope);
    expect(first.context.generation).toBe(1);
    expect(first.sourceCursor).toBe(0);
    expect(first.messages).toEqual([]);

    const user = await transcripts.append({
      ...scope,
      turnId: "turn-1",
      kind: "user",
      message: { role: "user", content: "Find my calendar events." },
      idempotencyKey: "turn-1-user",
    });
    const replayedUser = await transcripts.append({
      ...scope,
      turnId: "turn-1",
      kind: "user",
      message: { role: "user", content: "Find my calendar events." },
      idempotencyKey: "turn-1-user",
    });
    expect(user.outcome).toBe("created");
    expect(replayedUser.outcome).toBe("replayed");
    expect(replayedUser.entry.id).toBe(user.entry.id);
    await expect(transcripts.append({
      ...scope,
      turnId: "turn-1",
      kind: "user",
      message: { role: "user", content: "A conflicting retry." },
      idempotencyKey: "turn-1-user",
    })).rejects.toThrow("SESSION_TRANSCRIPT_IDEMPOTENCY_CONFLICT");

    await transcripts.append({ ...scope, turnId: "turn-1", kind: "assistant_tool_call", message: assistantCall(), idempotencyKey: "turn-1-call" });
    await transcripts.append({
      ...scope,
      turnId: "turn-1",
      kind: "tool_result",
      message: {
        role: "tool",
        name: "calendar.list",
        toolCallId: "provider-call-1",
        runtimeOperationId: "runtime-call-1",
        content: '{"events":[{"title":"Planning"}]}',
      },
      idempotencyKey: "turn-1-result",
    });
    await transcripts.append({
      ...scope,
      turnId: "turn-1",
      kind: "assistant_response",
      message: { role: "assistant", content: "You have one planning event." },
      idempotencyKey: "turn-1-final",
    });
    await transcripts.append({
      ...scope,
      turnId: "turn-2",
      kind: "user",
      message: { role: "user", content: "What time is it?" },
      idempotencyKey: "turn-2-user",
    });

    const projection = await transcripts.readActive(scope);
    expect(projection.sourceCursor).toBe(5);
    expect(projection.messages).toHaveLength(5);
    expect(projection.messages[1]?.toolCalls?.[0]?.runtimeOperationId).toBe("runtime-call-1");
    expect(projection.messages[2]?.content).toBe('{"events":[{"title":"Planning"}]}');
    expect(projection.messages.at(-1)).toEqual({ role: "user", content: "What time is it?" });

    const archiveThroughSequence = archiveThroughSequenceForCompaction(projection, 2);
    expect(archiveThroughSequence).toBe(3);
    const activationInput = {
      ...scope,
      turnId: "turn-2",
      operationId: "compact-turn-2",
      checkpointMessage: { role: "system" as const, content: "The calendar was checked." },
      checkpointMetadata: { source: "integration-test" },
      archiveThroughSequence,
      expectedHead: { sequence: projection.sourceCursor, digest: projection.sourceDigest },
    };
    const activated = await transcripts.activateCompaction(activationInput);
    expect(activated.outcome).toBe("created");
    expect(activated.projection.context.generation).toBe(1);
    expect(activated.projection.context.activeCheckpointSourceSequence).toBe(3);
    expect(activated.projection.messages).toEqual([
      { role: "system", content: "The calendar was checked." },
      { role: "assistant", content: "You have one planning event." },
      { role: "user", content: "What time is it?" },
    ]);

    const replayedActivation = await transcripts.activateCompaction(activationInput);
    expect(replayedActivation.outcome).toBe("replayed");
    expect(replayedActivation.projection.activeProjectionDigest).toBe(activated.projection.activeProjectionDigest);
    const archived = await pool.query<{ sequence: string; is_active: boolean }>(
      `SELECT sequence::text, is_active
       FROM agent_session_transcript_entries
       WHERE organization_id = $1 AND conversation_id = $2
       ORDER BY sequence`,
      [organizationId, scope.conversationId],
    );
    expect(archived.rows.filter((row) => Number(row.sequence) <= 3).every((row) => row.is_active === false)).toBe(true);
    expect(archived.rows.filter((row) => Number(row.sequence) > 3).every((row) => row.is_active === true)).toBe(true);

    const nextGeneration = await transcripts.startNewGeneration({ ...scope, expectedGeneration: 1 });
    expect(nextGeneration.generation).toBe(2);
    const resetProjection = await transcripts.readActive(scope);
    expect(resetProjection.context.generation).toBe(2);
    expect(resetProjection.sourceCursor).toBe(0);
    expect(resetProjection.messages).toEqual([]);
    const retainedHistory = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_session_transcript_entries WHERE organization_id = $1 AND conversation_id = $2 AND is_active = false",
      [organizationId, scope.conversationId],
    );
    expect(Number(retainedHistory.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it("fences concurrent transcript appends and stale lease owners in PostgreSQL", async () => {
    const scope = await createScope();
    const initial = await transcripts.readActive(scope);
    const appendInput = (suffix: string) => transcripts.append({
      ...scope,
      turnId: `concurrent-${suffix}`,
      kind: "user",
      message: { role: "user", content: `Concurrent request ${suffix}` },
      idempotencyKey: `concurrent-${suffix}`,
      expectedHead: { sequence: initial.sourceCursor, digest: initial.sourceDigest },
    });
    const appendResults = await Promise.allSettled([appendInput("one"), appendInput("two")]);
    expect(appendResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(appendResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(appendResults.find((result) => result.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: "SESSION_TRANSCRIPT_HEAD_CONFLICT" }) });
    expect((await transcripts.readActive(scope)).messages).toHaveLength(1);

    const sessionKey = `session:${randomUUID()}`;
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    await pool.query(
      `INSERT INTO agent_runs
        (id, organization_id, agent_definition_id, agent_version_id, installation_id, conversation_id,
         trigger_type, status, correlation_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'message', 'completed', $7, 'test'),
              ($8, $2, $3, $4, $5, $6, 'message', 'completed', $9, 'test')`,
      [firstRunId, organizationId, agentId, versionId, installationId, scope.conversationId, randomUUID(), secondRunId, randomUUID()],
    );
    const firstOwner = { organizationId, sessionKey, ownerId: "worker-one", runId: firstRunId, leaseDurationMs: 30_000 };
    const secondOwner = { organizationId, sessionKey, ownerId: "worker-two", runId: secondRunId, leaseDurationMs: 30_000 };
    const leaseResults = await Promise.all([leases.acquire(firstOwner), leases.acquire(secondOwner)]);
    expect(leaseResults.map((result) => result.outcome).sort()).toEqual(["acquired", "busy"]);
    const acquired = leaseResults.find((result) => result.outcome === "acquired");
    expect(acquired?.outcome).toBe("acquired");
    if (!acquired || acquired.outcome !== "acquired") throw new Error("lease integration fixture did not acquire a lease");
    const winner = acquired.lease;
    const winnerOwner = winner.run_id === firstRunId ? firstOwner : secondOwner;
    const loserOwner = winner.run_id === firstRunId ? secondOwner : firstOwner;
    const winnerInput = { ...winnerOwner, fencingToken: winner.fencing_token };
    const released = await leases.release(winnerInput);
    expect(released.outcome).toBe("released");
    const reacquired = await leases.acquire(loserOwner);
    expect(reacquired.outcome).toBe("acquired");
    if (reacquired.outcome !== "acquired") throw new Error("lease integration fixture did not reacquire a released lease");
    expect(BigInt(reacquired.lease.fencing_token)).toBe(BigInt(winner.fencing_token) + 1n);
    await expect(leases.assertCurrent(winnerInput)).resolves.toMatchObject({ outcome: "rejected", reason: "fenced" });
  });

  it("retains deterministic tool-operation scales across multiple user turns", async () => {
    for (const operationCount of [2, 5, 18, 32, 64, 128]) {
      const scope = await createScope();
      const firstTurnCount = Math.ceil(operationCount / 2);
      const turnCounts = [firstTurnCount, operationCount - firstTurnCount];
      let operationOffset = 0;
      for (const [turnIndex, turnCount] of turnCounts.entries()) {
        const turnId = `scale-${operationCount}-turn-${turnIndex + 1}`;
        await transcripts.append({
          ...scope,
          turnId,
          kind: "user",
          message: { role: "user", content: `Run ${turnCount} deterministic operations.` },
          idempotencyKey: `${turnId}:user`,
        });
        const calls = Array.from({ length: turnCount }, (_value, index) => ({
          id: `provider-${operationCount}-${operationOffset + index}`,
          runtimeOperationId: `runtime-${operationCount}-${operationOffset + index}`,
          name: "calendar.list",
          arguments: { index: operationOffset + index },
        }));
        await transcripts.append({
          ...scope,
          turnId,
          kind: "assistant_tool_call",
          message: { role: "assistant", content: "", toolCalls: calls },
          idempotencyKey: `${turnId}:tool-call-batch`,
        });
        for (const call of calls) {
          await transcripts.append({
            ...scope,
            turnId,
            kind: "tool_result",
            message: {
              role: "tool",
              name: call.name,
              toolCallId: call.id,
              runtimeOperationId: call.runtimeOperationId,
              content: JSON.stringify({ operation: call.runtimeOperationId, status: "completed" }),
            },
            idempotencyKey: `${turnId}:result:${call.runtimeOperationId}`,
          });
        }
        await transcripts.append({
          ...scope,
          turnId,
          kind: "assistant_response",
          message: { role: "assistant", content: `Completed ${turnCount} operations.` },
          idempotencyKey: `${turnId}:final`,
        });
        operationOffset += turnCount;
      }

      const projection = await transcripts.readActive(scope);
      expect(projection.messages.filter((message) => message.role === "tool")).toHaveLength(operationCount);
      expect(projection.messages.filter((message) => message.role === "assistant" && message.toolCalls?.length)).toHaveLength(2);
      expect(projection.messages.at(-1)).toEqual({ role: "assistant", content: `Completed ${turnCounts[1]} operations.` });
      expect(projection.activeProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
