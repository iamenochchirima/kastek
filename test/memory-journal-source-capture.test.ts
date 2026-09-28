import { describe, expect, it } from "vitest";
import { MemoryJournalSourceCapture } from "../src/memory/journal-source-capture";
import type { PersistedExecutionJournalEvent } from "../src/journal/contracts";

describe("memory journal source capture", () => {
  it("captures an ordered, redacted evidence envelope idempotently", async () => {
    const writes: unknown[] = [];
    const capture = new MemoryJournalSourceCapture(
      {
        async record(input) {
          writes.push(input);
          return { status: "created", event: { id: "source-1" } as never };
        },
      },
      {
        async resolve() {
          return {
            organizationId: "org-1",
            workspaceId: "workspace-1",
            agentDefinitionId: "agent-1",
            agentVersionId: "version-1",
            installationId: "installation-1",
            conversationId: "conversation-1",
          };
        },
      },
    );
    const event: PersistedExecutionJournalEvent = {
      id: "journal-1",
      sequence: 7,
      occurredAt: "2026-09-07T00:00:00.000Z",
      scope: { organizationId: "org-1", installationId: "installation-1", runId: "run-1", operationId: "turn-1" },
      event: { kind: "tool.invoked", data: { toolCallId: "call-1", capability: "memory_search", outcome: "completed" } },
    };
    const result = await capture.capture(event);
    expect(result).toMatchObject({ status: "created", eventId: "source-1" });
    const input = writes[0] as { eventType: string; eventSequence: number; evidence: { redaction: string; items: Array<{ content?: string }> } };
    expect(input.eventType).toBe("journal.tool.invoked");
    expect(input.eventSequence).toBe(7);
    expect(input.evidence.redaction).toBe("content_redacted");
    expect(input.evidence.items[0]?.content).toBeUndefined();
  });

  it("replays durable journal pages in order and resumes from the admitted cursor", async () => {
    const writes: number[] = [];
    const capture = new MemoryJournalSourceCapture(
      {
        async record(input) {
          writes.push(input.eventSequence ?? 0);
          return { status: "created", event: { id: `source-${input.eventSequence}` } as never };
        },
      },
      {
        async resolve() {
          return {
            organizationId: "org-1",
            workspaceId: "workspace-1",
            agentDefinitionId: "agent-1",
            agentVersionId: "version-1",
            installationId: "installation-1",
          };
        },
      },
    );
    const events = [1, 2, 3].map((sequence) => ({
      id: `journal-${sequence}`,
      sequence,
      occurredAt: `2026-09-07T00:00:0${sequence}.000Z`,
      scope: { organizationId: "org-1", installationId: "installation-1", runId: "run-1" },
      event: { kind: "run.transition" as const, data: { to: "running" as const } },
    }));
    const read = async ({ afterSequence = 0, limit = 200 }: { afterSequence?: number; limit?: number }) => events.filter((event) => event.sequence > afterSequence).slice(0, limit);
    const journal = { read };

    await expect(capture.replay({ journal, organizationId: "org-1", runId: "run-1", maxEvents: 2 })).resolves.toEqual({ captured: 2, replayed: 0, lastSequence: 2, hasMore: true });
    await expect(capture.replay({ journal, organizationId: "org-1", runId: "run-1" })).resolves.toEqual({ captured: 1, replayed: 0, lastSequence: 3, hasMore: false });
    expect(writes).toEqual([1, 2, 3]);
  });

  it("counts idempotent replay separately and rejects a crossed or non-monotonic cursor", async () => {
    const capture = new MemoryJournalSourceCapture(
      {
        async record(input) {
          return { status: input.eventSequence === 1 ? "replayed" : "created", event: { id: `source-${input.eventSequence}` } as never };
        },
      },
      { async resolve() { return { organizationId: "org-1", workspaceId: "workspace-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1" }; } },
    );
    const event = (sequence: number, organizationId = "org-1", runId = "run-1") => ({
      id: `journal-${sequence}`,
      sequence,
      occurredAt: "2026-09-07T00:00:00.000Z",
      scope: { organizationId, installationId: "installation-1", runId },
      event: { kind: "run.transition" as const, data: { to: "running" as const } },
    });

    await expect(capture.replay({
      journal: { read: async () => [event(1), event(1)] },
      organizationId: "org-1",
      runId: "run-1",
    })).rejects.toMatchObject({ code: "MEMORY_JOURNAL_REPLAY_CURSOR_INVALID" });
    await expect(capture.replay({
      journal: { read: async () => [event(2, "org-2")] },
      organizationId: "org-1",
      runId: "run-1",
    })).rejects.toMatchObject({ code: "MEMORY_JOURNAL_REPLAY_SCOPE_CONFLICT" });

    await expect(capture.replay({
      journal: { read: async () => [event(1, "org-1", "run-2")] },
      organizationId: "org-1",
      runId: "run-2",
    })).resolves.toMatchObject({ captured: 0, replayed: 1, lastSequence: 1 });
  });
});
