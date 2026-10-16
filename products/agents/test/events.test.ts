import { describe, expect, it } from "vitest";
import { createAgentEvent, agentEventEnvelopeSchema } from "../src/events/envelope";

describe("canonical agent event envelope", () => {
  it("creates a CloudEvents-compatible JSON event", () => {
    const event = createAgentEvent({ type: "agent.run.started", subject: "run:run-1", data: { attempt: 1 } });
    expect(agentEventEnvelopeSchema.parse(event)).toEqual(event);
    expect(event.specversion).toBe("1.0");
    expect(event.datacontenttype).toBe("application/json");
    expect(event.data).toEqual({ attempt: 1 });
  });

  it("rejects events without a stable subject", () => {
    expect(() => agentEventEnvelopeSchema.parse({ specversion: "1.0", id: "not-a-uuid" })).toThrow();
  });
});
