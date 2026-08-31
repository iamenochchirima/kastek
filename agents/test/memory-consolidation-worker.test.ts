import { describe, expect, it, vi } from "vitest";
import { MemoryConsolidationWorker } from "../src/memory/consolidation-worker";

const job = {
  id: "job-1",
  organization_id: "org-1",
  agent_definition_id: "agent-1",
  agent_version_id: "version-1",
  installation_id: "installation-1",
  conversation_id: "conversation-1",
  trigger_run_id: "run-1",
  extraction_version: "deterministic-v1",
  status: "running",
  attempt_count: 1,
  lease_owner: "worker-1",
  lease_expires_at: null,
  source_message_count: 0,
  candidate_count: 0,
  error: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  completed_at: null,
};

function inbound(id: string, text: string) {
  return { id, direction: "inbound", content: { text }, created_at: new Date().toISOString() };
}

describe("memory consolidation worker", () => {
  it("writes review-first inferred candidates after the evidence threshold", async () => {
    const jobs = { claimDue: vi.fn().mockResolvedValue([job]), markCompleted: vi.fn().mockResolvedValue(true), markRetryable: vi.fn() };
    const conversations = { listMessages: vi.fn().mockResolvedValue([
      inbound("message-1", "I prefer concise updates."),
      inbound("message-2", "Please help with the launch."),
      inbound("message-3", "The launch is next week."),
      inbound("message-4", "We decided that launches use the blue checklist."),
    ]) };
    const memory = {
      hasConsolidationCandidate: vi.fn().mockResolvedValue(false),
      countWritesForRun: vi.fn().mockResolvedValue(0),
      createMemory: vi.fn().mockResolvedValue({ id: "memory-1" }),
    };
    const runs = {
      getRuntimeRunById: vi.fn().mockResolvedValue({
        organization_id: "org-1",
        agent_definition_id: "agent-1",
        agent_version_id: "version-1",
        installation_id: "installation-1",
        conversation_id: "conversation-1",
        created_by: "user-1",
        policy: { memory: { mode: "automatic", maxWritesPerRun: 3 } },
      }),
    };
    const worker = new MemoryConsolidationWorker({} as never, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 4,
    }, { jobs: jobs as never, conversations: conversations as never, memory: memory as never, runs: runs as never, workerId: "worker-1" });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(memory.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: "inferred",
      memoryType: "semantic",
      provenance: expect.objectContaining({ sourceRunId: "run-1", sourceMessageIds: ["message-1"], extractionVersion: "deterministic-v1" }),
      reviewRequired: true,
      allowInferred: true,
    }));
    expect(memory.createMemory).toHaveBeenCalledTimes(2);
    expect(jobs.markCompleted).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", workerId: "worker-1", sourceMessageCount: 4, candidateCount: 2 }));
  });

  it("does not write for existing explicit-only installations", async () => {
    const jobs = { claimDue: vi.fn().mockResolvedValue([job]), markCompleted: vi.fn().mockResolvedValue(true), markRetryable: vi.fn() };
    const memory = { createMemory: vi.fn(), hasConsolidationCandidate: vi.fn() };
    const worker = new MemoryConsolidationWorker({} as never, {
      batchSize: 10,
      leaseMs: 120_000,
      pollIntervalMs: 5_000,
      maxAttempts: 5,
      minInboundMessages: 4,
    }, {
      jobs: jobs as never,
      conversations: { listMessages: vi.fn().mockResolvedValue([]) } as never,
      memory: memory as never,
      runs: { getRuntimeRunById: vi.fn().mockResolvedValue({
        organization_id: "org-1", agent_definition_id: "agent-1", agent_version_id: "version-1",
        installation_id: "installation-1", conversation_id: "conversation-1", created_by: "user-1",
        policy: { memory: { mode: "explicit" } },
      }) } as never,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(memory.createMemory).not.toHaveBeenCalled();
    expect(jobs.markCompleted).toHaveBeenCalledWith(expect.objectContaining({ candidateCount: 0 }));
  });
});
