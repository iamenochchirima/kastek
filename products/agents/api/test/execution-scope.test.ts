import { describe, expect, it } from "vitest";
import {
  assertExecutionScopeContained,
  createExecutionScope,
  executionScopeFromRun,
} from "../src/runtime/execution-scope";
import { toolInvocationContextFromScope } from "../src/tools/types";

describe("execution scope", () => {
  it("creates one identity envelope for a run and projects it to tools", () => {
    const scope = executionScopeFromRun({
      organization_id: "org",
      installation_id: "installation",
      agent_definition_id: "agent",
      agent_version_id: "version",
      extension_snapshot_id: "extension-snapshot",
      conversation_id: "conversation",
      id: "run",
      created_by: "actor",
      correlation_id: "correlation",
    }, { sessionKey: "conversation:installation:conversation", fencingToken: "9" });

    expect(scope).toMatchObject({
      organizationId: "org",
      installationId: "installation",
      agentDefinitionId: "agent",
      agentVersionId: "version",
      sessionId: "conversation",
      conversationId: "conversation",
      runId: "run",
      actorType: "service",
      extensionSnapshotId: "extension-snapshot",
      sessionKey: "conversation:installation:conversation",
      sessionFencingToken: "9",
    });
    expect(toolInvocationContextFromScope(scope)).toMatchObject({
      scope,
      agentId: "agent",
      runId: "run",
      operationId: undefined,
    });
  });

  it("rejects invalid identity and cross-installation scope escape", () => {
    expect(() => createExecutionScope({ organizationId: "org" })).toThrow();
    const parent = executionScopeFromRun({
      organization_id: "org",
      installation_id: "installation-a",
      agent_definition_id: "agent",
      agent_version_id: "version",
      id: "run",
      correlation_id: "correlation",
    });
    const child = { ...parent, installationId: "installation-b" };
    expect(() => assertExecutionScopeContained(parent, child)).toThrow("EXECUTION_SCOPE_ESCAPED:installationId");
    expect(() => assertExecutionScopeContained(parent, { ...parent })).not.toThrow();
  });
});
