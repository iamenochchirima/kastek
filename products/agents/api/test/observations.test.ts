import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { observationSchema, type ObservationIdentity } from "../src/contracts/observations";
import { makeObservation } from "../src/observability/observations";
const identity: ObservationIdentity = { product: "agents", organizationId: randomUUID(), agentId: randomUUID(), versionId: randomUUID(),
  programId: "tool-directed", programVersion: "1", runtimeRelease: "fixture", conversationId: randomUUID(), rootTaskId: randomUUID(),
  parentTaskId: null, taskId: randomUUID(), operationId: "model:fixture:0", attemptId: randomUUID() };
describe("versioned native observations", () => {
  it("exports only approved metadata, without model content or provider secrets", () => {
    const result = makeObservation({ identity, eventKey: "model:0:completed", kind: "model.completed", occurredAt: new Date().toISOString(),
      metadata: { totalTokens: 42, prompt: "private question", arguments: "private tool input", authorization: "Bearer secret", errorCode: "secret with spaces", count: -1 } });
    expect(result.metadata).toEqual({ totalTokens: 42 });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("keeps a stable logical identity across replay while distinguishing physical attempts", () => {
    const input = { identity, eventKey: "operation:0:completed", kind: "tool.completed", occurredAt: new Date().toISOString() };
    expect(makeObservation(input).id).toBe(makeObservation({ ...input, occurredAt: new Date(Date.now() + 10).toISOString() }).id);
    const retry = makeObservation({ ...input, identity: { ...identity, attemptId: randomUUID() }, eventKey: "operation:0:attempt:2" });
    expect(retry.id).not.toBe(makeObservation(input).id);
    expect(retry.identity.attemptId).not.toBe(identity.attemptId);
  });
  it("rejects untyped private fields and retains delegation attribution", () => {
    const child = makeObservation({ identity: { ...identity, parentTaskId: randomUUID() }, eventKey: "children:0", kind: "children.admitted", occurredAt: new Date().toISOString() });
    expect(child.category).toBe("delegation");
    expect(() => observationSchema.parse({ ...child, prompt: "should not be accepted" })).toThrow();
    expect(child.identity.rootTaskId).toBe(identity.rootTaskId);
  });
});
