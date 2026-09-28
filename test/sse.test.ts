import { describe, expect, it } from "vitest";
import { advanceSseCursor, formatSseComment, formatSseEvent } from "../src/http/sse";

describe("run event SSE formatting", () => {
  it("emits resumable event IDs and JSON data", () => {
    expect(formatSseEvent({ sequence_number: "12", event_type: "run.running", ok: true, payload: { status: "running", prompt: "hidden" }, created_at: "2026-08-11T00:00:00.000Z", organization_id: "private" })).toBe(
      'id: 12\nevent: run.running\ndata: {"sequence_number":"12","event_type":"run.running","payload":{"status":"running"},"created_at":"2026-08-11T00:00:00.000Z"}\n\n',
    );
  });

  it("emits keep-alive comments", () => {
    expect(formatSseComment("keep-alive")).toBe(": keep-alive\n\n");
  });

  it("projects bounded approval-group evidence without private payload fields", () => {
    const formatted = formatSseEvent({
      sequence_number: "13",
      event_type: "agent.approval.group.approved",
      payload: {
        approvalGroupId: "group-1",
        batchId: "batch-1",
        planDigest: "a".repeat(64),
        operationCount: 18,
        selectedCount: 9,
        selectedOperationIds: ["operation-1"],
        approvedBy: "operator-1",
        arguments: { secret: "must-not-appear" },
        resourceSnapshot: { title: "private" },
      },
      created_at: "2026-08-11T00:00:00.000Z",
    });
    expect(formatted).toContain('"approvalGroupId":"group-1"');
    expect(formatted).toContain('"operationCount":18');
    expect(formatted).toContain('"selectedCount":9');
    expect(formatted).not.toContain("must-not-appear");
    expect(formatted).not.toContain("resourceSnapshot");
  });

  it("advances reconnect cursors monotonically across duplicate and out-of-order rows", () => {
    expect(advanceSseCursor(10, [
      { sequence_number: "12" },
      { sequence_number: 12 },
      { sequence_number: "11" },
      { sequence_number: "not-a-sequence" },
      {},
    ])).toBe(12);
    expect(advanceSseCursor(12, [{ sequence_number: 7 }, { sequence_number: "12" }])).toBe(12);
  });
});
