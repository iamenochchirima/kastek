import type {
  HandoffMutationResult,
  HandoffQueueFilters,
  HandoffQueuePage,
  HandoffQueueItem,
  HandoffRepository,
} from "../db/repositories/handoff-repository";

/** Operator-side controls for the same ownership state used by agent actions. */
export class ConversationControlService {
  public constructor(private readonly handoffs: HandoffRepository) {}

  public listHandoffs(organizationId: string, filters?: HandoffQueueFilters): Promise<HandoffQueuePage> {
    return this.handoffs.listQueue(organizationId, filters);
  }

  public getHandoff(organizationId: string, handoffId: string): Promise<HandoffQueueItem | null> {
    return this.handoffs.get(organizationId, handoffId);
  }

  public claim(input: { organizationId: string; handoffId: string; actorId: string }): Promise<HandoffMutationResult> {
    return this.handoffs.claim(input);
  }

  public continueWithAgent(input: { organizationId: string; handoffId: string; actorId: string; resolution?: string }): Promise<HandoffMutationResult> {
    return this.handoffs.continueWithAgent(input);
  }

  public resolve(input: { organizationId: string; handoffId: string; actorId: string; resolution?: string }): Promise<HandoffMutationResult> {
    return this.handoffs.resolve(input);
  }
}
