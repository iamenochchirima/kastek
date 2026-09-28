import { describe, expect, it } from "vitest";
import { createScopedAgentEvent, executionEventIdentityFromScope } from "../src/runtime/execution-evidence";
import type { ExecutionScope } from "../src/runtime/execution-scope";

const scope: ExecutionScope = {
  organizationId: "org-1",
  installationId: "install-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-2",
  sessionId: "session-1",
  conversationId: "conversation-1",
  runId: "run-1",
  actorId: "actor-1",
  actorType: "user",
  extensionSnapshotId: "extension-1",
  correlationId: "corr-1",
  causationId: "cause-1",
};

describe("execution evidence", () => {
  it("projects the canonical scope identity and release", () => {
    expect(executionEventIdentityFromScope(scope, { operationId: "op-1", releaseId: "release-1" })).toEqual({
      organizationId: "org-1",
      installationId: "install-1",
      agentDefinitionId: "agent-1",
      agentVersionId: "version-2",
      sessionId: "session-1",
      conversationId: "conversation-1",
      runId: "run-1",
      operationId: "op-1",
      actorId: "actor-1",
      actorType: "user",
      correlationId: "corr-1",
      causationId: "cause-1",
      releaseId: "release-1",
    });
  });

  it("does not allow payload data to replace canonical execution identity", () => {
    const event = createScopedAgentEvent({
      scope,
      type: "tool.completed",
      data: { _execution: { organizationId: "wrong-org" }, output: { ok: true } },
    });
    expect(event.data._execution).toMatchObject({ organizationId: "org-1", runId: "run-1" });
    expect(event.data.output).toEqual({ ok: true });
  });
});
