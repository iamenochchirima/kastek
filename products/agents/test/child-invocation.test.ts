import { describe, expect, it } from "vitest";
import { InMemoryChildInvocationCoordinator } from "../src/children";
import { createExecutionScope } from "../src/runtime/execution-scope";

const parent = createExecutionScope({
  organizationId: "org-a",
  installationId: "installation-a",
  agentDefinitionId: "parent-agent",
  agentVersionId: "parent-version",
  sessionId: "session-a",
  conversationId: "conversation-a",
  runId: "parent-run",
  correlationId: "correlation-a",
  capabilityGrants: ["calendar.read", "crm.write"],
  resourceGrants: ["calendar:primary", "contact:42"],
});

describe("child invocation foundation", () => {
  it("attenuates authority, preserves lineage, and bounds context", async () => {
    let received: unknown;
    const coordinator = new InMemoryChildInvocationCoordinator({
      async execute(input) {
        received = input;
        return { ok: true };
      },
    });

    const result = await coordinator.invoke(parent, {
      childAgentDefinitionId: "research-agent",
      childAgentVersionId: "research-v2",
      idempotencyKey: "research-contact-42",
      input: { contactId: "42", question: "qualify" },
      capabilityGrants: ["calendar.read"],
      resourceGrants: ["contact:42"],
    });

    expect(result).toMatchObject({ status: "succeeded", output: { ok: true } });
    expect(received).toMatchObject({
      scope: {
        parentRunId: "parent-run",
        organizationId: "org-a",
        installationId: "installation-a",
        sessionId: "session-a",
        conversationId: "conversation-a",
        correlationId: "correlation-a",
        causationId: "parent-run",
        childAgentDefinitionId: "research-agent",
        childAgentVersionId: "research-v2",
        capabilityGrants: ["calendar.read"],
        resourceGrants: ["contact:42"],
      },
      input: { contactId: "42", question: "qualify" },
    });
  });

  it("rejects authority expansion before a child can execute", async () => {
    const coordinator = new InMemoryChildInvocationCoordinator({ async execute() { return "unexpected"; } });
    expect(() => coordinator.invoke(parent, {
      childAgentDefinitionId: "child",
      childAgentVersionId: "v1",
      idempotencyKey: "cannot-expand",
      input: {},
      capabilityGrants: ["billing.write"],
      resourceGrants: [],
    })).toThrow("CHILD_AUTHORITY_EXPANSION:billing.write");
  });

  it("deduplicates concurrent and replayed calls by parent run and idempotency key", async () => {
    let executions = 0;
    const coordinator = new InMemoryChildInvocationCoordinator({
      async execute() {
        executions += 1;
        return "done";
      },
    });
    const request = {
      childAgentDefinitionId: "child",
      childAgentVersionId: "v1",
      idempotencyKey: "stable-key",
      input: { value: 1 },
      capabilityGrants: [],
      resourceGrants: [],
    };

    const [first, second, replay] = await Promise.all([
      coordinator.invoke(parent, request),
      coordinator.invoke(parent, request),
      coordinator.invoke(parent, request),
    ]);
    expect(executions).toBe(1);
    expect(first).toEqual(second);
    expect(second).toEqual(replay);
  });

  it("returns a typed failure result when the child fails", async () => {
    const coordinator = new InMemoryChildInvocationCoordinator({
      async execute() { throw new Error("provider unavailable"); },
    });
    await expect(coordinator.invoke(parent, {
      childAgentDefinitionId: "child",
      childAgentVersionId: "v1",
      idempotencyKey: "failure",
      input: {},
      capabilityGrants: [],
      resourceGrants: [],
    })).resolves.toMatchObject({
      status: "failed",
      error: { code: "CHILD_INVOCATION_FAILED", message: "provider unavailable" },
    });
  });
});
