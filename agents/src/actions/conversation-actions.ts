import type { HandoffPriority, HandoffReason, HandoffRepository } from "../db/repositories/handoff-repository";
import type { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import type { ToolInvocationContext } from "../tools/types";

export interface RequestHumanArguments {
  conversationId?: string;
  reason: HandoffReason;
  priority?: HandoffPriority;
  summary: string;
  customerMessage?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface RequestHumanResult {
  status: "handoff_requested";
  handoffRequestId: string;
  conversationId: string;
  agentPaused: true;
  created: boolean;
  control: "awaiting_human";
}

/**
 * Protocol-neutral conversation actions. Browser operators, workflow nodes,
 * hosted agents, and MCP clients should call this service instead of writing
 * conversation ownership state independently.
 */
export class ConversationActionService {
  public constructor(
    private readonly handoffs: HandoffRepository,
    private readonly controls?: Pick<OperatorControlRepository, "isFeatureEnabled">,
  ) {}

  public async requestHuman(context: ToolInvocationContext, input: RequestHumanArguments): Promise<RequestHumanResult> {
    const conversationId = input.conversationId?.trim() || context.conversationId;
    if (!conversationId) {
      throw Object.assign(new Error("A conversation is required for human handoff"), {
        statusCode: 400,
        code: "conversation_target_required",
      });
    }
    if (this.controls && !(await this.controls.isFeatureEnabled(context.organizationId, "customer_handoff_enabled", context.installationId))) {
      throw Object.assign(new Error("Customer handoff is disabled by an active feature policy"), {
        statusCode: 403,
        code: "CUSTOMER_HANDOFF_FEATURE_DISABLED",
      });
    }
    const result = await this.handoffs.requestHuman({
      organizationId: context.organizationId,
      installationId: context.installationId,
      agentId: context.agentId,
      agentVersionId: context.agentVersionId,
      runId: context.runId,
      conversationId,
      actorId: context.actorId,
      reason: input.reason,
      priority: input.priority ?? "normal",
      summary: input.summary,
      customerMessage: input.customerMessage,
      metadata: input.metadata,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      status: "handoff_requested",
      handoffRequestId: result.handoff.id,
      conversationId: result.conversation.id,
      agentPaused: true,
      created: result.created,
      control: "awaiting_human",
    };
  }
}
