import { describe, expect, it, vi } from "vitest";
import { AgentUiInteractionCoordinator } from "../src/actions/ui-interaction-coordinator";

const organizationId = "org-1";
const installationId = "install-1";
const actorId = "user-1";
const conversationId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";

function fixtureUi() {
  return {
    version: "1" as const,
    mode: "inline" as const,
    blocks: [
      {
        type: "list" as const,
        id: "accounts",
        title: "Accounts",
        items: [{ title: "Instagram" }],
        actions: [
          { id: "refresh", label: "Refresh", kind: "refresh" as const },
          { id: "follow", label: "Review", kind: "follow_up" as const, prompt: "Review the account details." },
        ],
      },
      {
        type: "form" as const,
        id: "agent-form",
        title: "New agent",
        fields: [
          { id: "name", label: "Name", type: "text" as const, required: true, maxLength: 80 },
          { id: "audience", label: "Audience", type: "select" as const, required: true, options: [{ id: "personal", label: "Personal", value: "personal" }] },
        ],
        actions: [{ id: "create", label: "Create", kind: "submit" as const, targetId: "agent-form" }],
      },
      {
        type: "choice" as const,
        id: "choice",
        title: "Choose",
        options: [{ id: "yes", label: "Yes", value: "yes" }],
      },
    ],
  };
}

function createCoordinator(overrides: Record<string, unknown> = {}) {
  const acceptMessage = vi.fn(async (input: Record<string, unknown>) => ({
    conversation: { id: conversationId },
    userParticipant: { id: "user-participant" },
    agentParticipant: { id: "agent-participant" },
    message: { id: "new-message", content: { text: input.message } },
    run: { id: "new-run", status: "received" },
    created: true,
  }));
  const startWorkflow = vi.fn(async () => undefined);
  const signalExternalEvent = vi.fn(async () => undefined);
  const coordinator = new AgentUiInteractionCoordinator({
    conversations: {
      getConversation: vi.fn(async () => ({ id: conversationId, installation_id: installationId, owner_actor_id: actorId, status: "active" })),
      getMessage: vi.fn(async () => ({ id: messageId, direction: "outbound", source_channel: "platform", run_id: null, content: { ui: fixtureUi() } })),
    } as never,
    runs: { getRun: vi.fn(async () => ({ id: "waiting-run", installation_id: installationId, conversation_id: conversationId, status: "awaiting_external_event" })) } as never,
    platformChat: { acceptMessage } as never,
    startWorkflow,
    signalExternalEvent,
    temporalEnabled: true,
    ...overrides,
  });
  return { coordinator, acceptMessage, startWorkflow, signalExternalEvent };
}

const baseInput = { organizationId, installationId, actorId, conversationId, messageId, idempotencyKey: "ui-action-key-1" };

describe("Agent UI interaction coordinator", () => {
  it("resolves a refresh without bypassing platform admission", async () => {
    const { coordinator, acceptMessage } = createCoordinator();
    const result = await coordinator.resolveAndExecute({ ...baseInput, blockId: "accounts", actionId: "refresh" });
    expect(result.kind).toBe("run");
    expect(acceptMessage).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("Refresh") }));
  });

  it("dispatches follow-up and form submissions through platform admission", async () => {
    const { coordinator, acceptMessage, startWorkflow } = createCoordinator();
    const followUp = await coordinator.resolveAndExecute({ ...baseInput, blockId: "accounts", actionId: "follow" });
    expect(followUp.kind).toBe("run");
    expect(acceptMessage).toHaveBeenCalledWith(expect.objectContaining({ message: "Review the account details." }));
    const form = await coordinator.resolveAndExecute({
      ...baseInput,
      actionId: "create",
      blockId: "agent-form",
      idempotencyKey: "ui-action-key-2",
      values: { name: "Support agent", audience: "personal" },
    });
    expect(form.kind).toBe("run");
    expect(acceptMessage).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining("Support agent") }));
    expect(startWorkflow).toHaveBeenCalledTimes(2);
  });

  it("resolves a choice from the stored option and rejects invalid form values", async () => {
    const { coordinator, acceptMessage } = createCoordinator();
    const choice = await coordinator.resolveAndExecute({ ...baseInput, blockId: "choice", actionId: "yes" });
    expect(choice.kind).toBe("run");
    expect(acceptMessage).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("yes") }));
    await expect(coordinator.resolveAndExecute({
      ...baseInput,
      blockId: "agent-form",
      actionId: "create",
      idempotencyKey: "ui-action-key-3",
      values: { name: "Missing audience", audience: "not-allowed" },
    })).rejects.toMatchObject({ code: "ui_values_invalid", statusCode: 400 });
  });

  it("resumes a waiting run only through the existing external event signal", async () => {
    const getMessage = vi.fn(async () => ({ id: messageId, direction: "outbound", source_channel: "platform", run_id: "waiting-run", content: { ui: { version: "1", mode: "inline", blocks: [{ type: "list", id: "accounts", items: [{ title: "Account" }], actions: [{ id: "resume", label: "Resume", kind: "resume", eventKey: "account.connected" }] }] } } }));
    const signalExternalEvent = vi.fn(async () => undefined);
    const { coordinator } = createCoordinator({
      conversations: { getConversation: vi.fn(async () => ({ id: conversationId, installation_id: installationId, owner_actor_id: actorId, status: "active" })), getMessage },
      signalExternalEvent,
    });
    const result = await coordinator.resolveAndExecute({ ...baseInput, blockId: "accounts", actionId: "resume", values: { connectionId: "safe-id" } });
    expect(result.kind).toBe("resumed");
    expect(signalExternalEvent).toHaveBeenCalledWith("waiting-run", { key: "account.connected", payload: { connectionId: "safe-id" } });
  });

  it("rejects a disabled interaction surface and does not admit a run", async () => {
    const acceptMessage = vi.fn();
    const { coordinator } = createCoordinator({
      platformChat: { acceptMessage },
      isDynamicUiEnabled: vi.fn(async () => false),
    });
    await expect(coordinator.resolveAndExecute({ ...baseInput, blockId: "accounts", actionId: "refresh" }))
      .rejects.toMatchObject({ code: "dynamic_ui_disabled", statusCode: 409 });
    expect(acceptMessage).not.toHaveBeenCalled();
  });

  it("does not signal a completed resume receipt twice", async () => {
    let completed = false;
    const claim = vi.fn(async () => completed
      ? { created: false, receipt: { block_id: "accounts", action_id: "resume", event_key: "account.connected", status: "completed", run_id: "waiting-run", values: { connectionId: "safe-id" } } }
      : { created: true, receipt: { block_id: "accounts", action_id: "resume", event_key: "account.connected", status: "started", run_id: null, values: { connectionId: "safe-id" } } });
    const complete = vi.fn(async () => { completed = true; });
    const signalExternalEvent = vi.fn(async () => undefined);
    const getMessage = vi.fn(async () => ({ id: messageId, direction: "outbound", source_channel: "platform", run_id: "waiting-run", content: { ui: { version: "1", mode: "inline", blocks: [{ type: "list", id: "accounts", items: [{ title: "Account" }], actions: [{ id: "resume", label: "Resume", kind: "resume", eventKey: "account.connected" }] }] } } }));
    const { coordinator } = createCoordinator({
      conversations: { getConversation: vi.fn(async () => ({ id: conversationId, installation_id: installationId, owner_actor_id: actorId, status: "active" })), getMessage },
      signalExternalEvent,
      uiInteractions: { claim, complete, fail: vi.fn(async () => undefined) },
    });
    await coordinator.resolveAndExecute({ ...baseInput, blockId: "accounts", actionId: "resume", values: { connectionId: "safe-id" } });
    await coordinator.resolveAndExecute({ ...baseInput, blockId: "accounts", actionId: "resume", values: { connectionId: "safe-id" } });
    expect(signalExternalEvent).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
