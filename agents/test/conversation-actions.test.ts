import { describe, expect, it, vi } from "vitest";
import { ConversationActionService, type RequestHumanResult } from "../src/actions/conversation-actions";
import { ConversationControlService } from "../src/actions/conversation-controls";
import { createDefaultTools } from "../src/temporal/activities";
import type { HandoffRepository } from "../src/db/repositories/handoff-repository";

const context = {
  organizationId: "org-1",
  agentId: "agent-1",
  agentVersionId: "version-1",
  installationId: "installation-1",
  runId: "run-1",
  conversationId: "conversation-1",
  actorId: "agent:agent-1",
  correlationId: "corr-1",
};

describe("conversation action contract", () => {
  it("normalizes a model action into the shared handoff service", async () => {
    const requestHuman = vi.fn(async () => ({
      handoff: { id: "handoff-1" },
      conversation: { id: "conversation-1" },
      created: true,
    }));
    const service = new ConversationActionService({ requestHuman } as unknown as HandoffRepository);

    await expect(service.requestHuman(context, {
      reason: "customer_requested",
      summary: "Customer asked for a person.",
      priority: "high",
    })).resolves.toEqual({
      status: "handoff_requested",
      handoffRequestId: "handoff-1",
      conversationId: "conversation-1",
      agentPaused: true,
      created: true,
      control: "awaiting_human",
    } satisfies RequestHumanResult);
    expect(requestHuman).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: "org-1",
      installationId: "installation-1",
      conversationId: "conversation-1",
      priority: "high",
    }));
  });

  it("publishes request_human through the hosted registry and marks it as a runtime control", async () => {
    const service = new ConversationActionService({
      requestHuman: vi.fn(async () => ({
        handoff: { id: "handoff-1" },
        conversation: { id: "conversation-1" },
        created: true,
      })),
    } as unknown as HandoffRepository);
    const registry = createDefaultTools(undefined, service);
    const manifest = registry.get("conversation.request_human");
    expect(manifest).toMatchObject({
      riskClass: "controlled-write",
      requiresApproval: false,
      manifest: { requiredScope: "conversations.handoff", idempotency: "required" },
    });

    const result = await registry.invoke({
      name: "conversation.request_human",
      arguments: { reason: "customer_requested", summary: "Please connect me to a person." },
      grantedTools: new Set(["conversation.request_human"]),
      context,
    });
    expect(result.control).toBe("awaiting_human");
    expect(result.output).toMatchObject({ handoffRequestId: "handoff-1", agentPaused: true });
  });

  it("requires a conversation target instead of creating an unscoped request", async () => {
    const service = new ConversationActionService({ requestHuman: vi.fn() } as unknown as HandoffRepository);
    await expect(service.requestHuman({ ...context, conversationId: undefined }, {
      reason: "agent_uncertain",
      summary: "No conversation context.",
    })).rejects.toMatchObject({ code: "conversation_target_required", statusCode: 400 });
  });

  it("fails closed when the customer handoff rollout flag is disabled", async () => {
    const requestHuman = vi.fn();
    const controls = { isFeatureEnabled: vi.fn(async () => false) };
    const service = new ConversationActionService(
      { requestHuman } as unknown as HandoffRepository,
      controls,
    );

    await expect(service.requestHuman(context, {
      reason: "customer_requested",
      summary: "Customer requested a person.",
    })).rejects.toMatchObject({
      code: "CUSTOMER_HANDOFF_FEATURE_DISABLED",
      statusCode: 403,
    });
    expect(controls.isFeatureEnabled).toHaveBeenCalledWith("org-1", "customer_handoff_enabled", "installation-1");
    expect(requestHuman).not.toHaveBeenCalled();
  });

  it("keeps operator controls on the same handoff repository boundary", async () => {
    const handoffs = {
      listQueue: vi.fn(async () => ({ items: [], nextBefore: null })),
      get: vi.fn(async () => null),
      claim: vi.fn(async (input: { organizationId: string; handoffId: string; actorId: string }) => ({ handoff: { id: input.handoffId }, conversation: { id: "conversation-1" }, changed: true })),
      continueWithAgent: vi.fn(async () => ({ handoff: { id: "handoff-1" }, conversation: { id: "conversation-1" }, changed: true })),
      resolve: vi.fn(async () => ({ handoff: { id: "handoff-1" }, conversation: { id: "conversation-1" }, changed: true })),
      appendHumanMessage: vi.fn(async (input: { organizationId: string; handoffId: string; actorId: string; text: string; idempotencyKey: string }) => ({
        handoff: { id: input.handoffId },
        conversation: { id: "conversation-1" },
        message: { id: "message-1" },
        deliveryAttemptId: null,
        created: true,
      })),
    } as unknown as HandoffRepository;
    const controls = new ConversationControlService(handoffs);
    await controls.claim({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1" });
    await controls.continueWithAgent({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1" });
    await controls.resolve({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1", resolution: "done" });
    await controls.sendHumanMessage({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1", text: "I can help.", idempotencyKey: "message-1" });
    expect(handoffs.claim).toHaveBeenCalledWith({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1" });
    expect(handoffs.continueWithAgent).toHaveBeenCalledWith({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1" });
    expect(handoffs.resolve).toHaveBeenCalledWith({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1", resolution: "done" });
    expect(handoffs.appendHumanMessage).toHaveBeenCalledWith({ organizationId: "org-1", handoffId: "handoff-1", actorId: "operator-1", text: "I can help.", idempotencyKey: "message-1" });
  });
});
