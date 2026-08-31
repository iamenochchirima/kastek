import type { HandoffPriority, HandoffRepository } from "../db/repositories/handoff-repository";
import type { HandoffOfferReason } from "../handoff/service";
import type { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import type { ToolInvocationContext } from "../tools/types";

export interface OfferHandoffArguments {
  conversationId?: string;
  reason: HandoffOfferReason;
  priority?: HandoffPriority;
  summary: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface OfferHandoffResult {
  status: "handoff_offered";
  handoffOfferId: string;
  conversationId: string;
  created: boolean;
  control: "continue";
}

/** @deprecated Kept as a source-compatible alias for older workflow imports. */
export type RequestHumanArguments = OfferHandoffArguments;
/** @deprecated The model-facing action now creates an offer, never a request. */
export type RequestHumanResult = OfferHandoffResult;

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

  public async offerHandoff(context: ToolInvocationContext, input: OfferHandoffArguments): Promise<OfferHandoffResult> {
    const conversationId = input.conversationId?.trim() || context.conversationId;
    if (!conversationId) {
      throw Object.assign(new Error("A conversation is required for a handoff offer"), {
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
    const result = await this.handoffs.offerHandoff({
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
      metadata: input.metadata,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      status: "handoff_offered",
      handoffOfferId: result.offer.id,
      conversationId: result.conversation.id,
      created: result.created,
      control: "continue",
    };
  }

  /**
   * Compatibility alias for older installed agent versions. It is deliberately
   * offer-only so stale prompts cannot bypass customer consent.
   */
  public async requestHuman(context: ToolInvocationContext, input: RequestHumanArguments): Promise<RequestHumanResult> {
    return this.offerHandoff(context, input);
  }
}
