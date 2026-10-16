import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { describe, expect, it } from "vitest";
import {
  TemporalChildInvocationCoordinator,
  childWorkflowId,
  type TemporalChildWorkflowAdapter,
  type TemporalChildWorkflowHandle,
  type TemporalChildWorkflowStartOptions,
} from "../src/children";
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

class FakeTemporalAdapter implements TemporalChildWorkflowAdapter {
  readonly starts: Array<{ workflowType: string; options: TemporalChildWorkflowStartOptions<unknown> }> = [];
  private readonly records = new Map<string, TemporalChildWorkflowHandle<unknown>>();

  constructor(private readonly result: unknown | (() => Promise<unknown>)) {}

  async start<TInput, TOutput>(workflowType: string, options: TemporalChildWorkflowStartOptions<TInput>): Promise<TemporalChildWorkflowHandle<TOutput>> {
    this.starts.push({ workflowType, options: options as TemporalChildWorkflowStartOptions<unknown> });
    const existing = this.records.get(options.workflowId);
    if (existing) {
      throw new WorkflowExecutionAlreadyStartedError("workflow already started", options.workflowId, workflowType);
    }
    const output = typeof this.result === "function" ? (this.result as () => Promise<unknown>)() : Promise.resolve(this.result);
    const handle: TemporalChildWorkflowHandle<unknown> = {
      workflowId: options.workflowId,
      firstExecutionRunId: `child-run-${options.workflowId.slice(-12)}`,
      result: () => output,
    };
    this.records.set(options.workflowId, handle);
    return handle as TemporalChildWorkflowHandle<TOutput>;
  }

  getHandle<TOutput>(workflowId: string): TemporalChildWorkflowHandle<TOutput> {
    const handle = this.records.get(workflowId);
    if (!handle) throw new Error(`missing fake workflow ${workflowId}`);
    return handle as TemporalChildWorkflowHandle<TOutput>;
  }
}

const request = {
  childAgentDefinitionId: "research-agent",
  childAgentVersionId: "research-v2",
  idempotencyKey: "research-contact-42",
  input: { contactId: "42", question: "qualify" },
  capabilityGrants: ["calendar.read"],
  resourceGrants: ["contact:42"],
};

describe("Temporal child invocation coordinator", () => {
  it("starts one bounded child with deterministic identity and parent/child evidence", async () => {
    const adapter = new FakeTemporalAdapter({ qualified: true });
    const coordinator = new TemporalChildInvocationCoordinator(adapter, {
      workflowType: "kasitek.agent.child",
      taskQueue: "agents",
    });

    const result = await coordinator.invoke(parent, request);
    const started = adapter.starts[0];

    expect(result).toMatchObject({
      status: "succeeded",
      output: { qualified: true },
      evidence: {
        invocationId: result.invocationId,
        workflowId: childWorkflowId(result.invocationId),
        startDisposition: "started",
        firstExecutionRunId: expect.stringMatching(/^child-run-/),
        parent: {
          organizationId: "org-a",
          installationId: "installation-a",
          runId: "parent-run",
          correlationId: "correlation-a",
        },
        child: {
          agentDefinitionId: "research-agent",
          agentVersionId: "research-v2",
          capabilityGrants: ["calendar.read"],
          resourceGrants: ["contact:42"],
        },
      },
    });
    expect(started?.workflowType).toBe("kasitek.agent.child");
    expect(started?.options).toMatchObject({
      workflowId: result.evidence.workflowId,
      taskQueue: "agents",
      workflowIdConflictPolicy: "USE_EXISTING",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      args: [{
        scope: {
          parentRunId: "parent-run",
          organizationId: "org-a",
          installationId: "installation-a",
          childAgentDefinitionId: "research-agent",
          childAgentVersionId: "research-v2",
          capabilityGrants: ["calendar.read"],
          resourceGrants: ["contact:42"],
        },
        input: request.input,
      }],
    });
  });

  it("recovers the existing workflow for concurrent or replayed idempotent starts", async () => {
    const adapter = new FakeTemporalAdapter({ answer: 42 });
    const coordinator = new TemporalChildInvocationCoordinator(adapter, {
      workflowType: "kasitek.agent.child",
      taskQueue: "agents",
    });

    const [first, replay] = await Promise.all([
      coordinator.invoke(parent, request),
      coordinator.invoke(parent, request),
    ]);

    expect(adapter.starts).toHaveLength(2);
    expect(first.invocationId).toBe(replay.invocationId);
    expect(first.evidence.workflowId).toBe(replay.evidence.workflowId);
    expect(first.evidence.firstExecutionRunId).toBe(replay.evidence.firstExecutionRunId);
    expect(first.evidence.startDisposition).toBe("started");
    expect(replay.evidence.startDisposition).toBe("recovered");
    expect(first.output).toEqual(replay.output);
  });

  it("rejects grant expansion before contacting Temporal", async () => {
    const adapter = new FakeTemporalAdapter("unexpected");
    const coordinator = new TemporalChildInvocationCoordinator(adapter, {
      workflowType: "kasitek.agent.child",
      taskQueue: "agents",
    });

    await expect(coordinator.invoke(parent, {
      ...request,
      capabilityGrants: ["billing.write"],
    })).rejects.toThrow("CHILD_AUTHORITY_EXPANSION:billing.write");
    expect(adapter.starts).toHaveLength(0);
  });

  it("returns typed child failure evidence when the workflow fails", async () => {
    const adapter = new FakeTemporalAdapter(async () => { throw new Error("child provider unavailable"); });
    const coordinator = new TemporalChildInvocationCoordinator(adapter, {
      workflowType: "kasitek.agent.child",
      taskQueue: "agents",
    });

    await expect(coordinator.invoke(parent, request)).resolves.toMatchObject({
      status: "failed",
      error: { code: "Error", message: "child provider unavailable" },
      evidence: {
        startDisposition: "started",
        parent: { runId: "parent-run" },
        child: { agentVersionId: "research-v2" },
      },
    });
  });
});
