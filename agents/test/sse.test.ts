import { describe, expect, it } from "vitest";
import { formatSseComment, formatSseEvent } from "../src/http/sse";

describe("run event SSE formatting", () => {
  it("emits resumable event IDs and JSON data", () => {
    expect(formatSseEvent({ sequence_number: "12", event_type: "run.running", ok: true })).toBe(
      'id: 12\nevent: run.running\ndata: {"sequence_number":"12","event_type":"run.running","ok":true}\n\n',
    );
  });

  it("emits keep-alive comments", () => {
    expect(formatSseComment("keep-alive")).toBe(": keep-alive\n\n");
  });
});
