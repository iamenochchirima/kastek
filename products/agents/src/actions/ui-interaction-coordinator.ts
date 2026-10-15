import { agentUiSchema, type AgentUi, type UiAction } from "../media/dynamic-ui";
import type { ExternalEventSignal } from "../temporal/contracts";
import type { ConversationRepository, ConversationRecord, MessageRecord } from "../db/repositories/conversation-repository";
import type { PlatformChatRepository, AcceptedPlatformMessage } from "../db/repositories/platform-chat-repository";
import type { RunRecord, RunRepository } from "../db/repositories/run-repository";
import type { UiInteractionRepository } from "../db/repositories/ui-interaction-repository";
import { recordDynamicUiInteraction, withSpan } from "../telemetry/spans";

type UiInteractionValues = Record<string, unknown>;

export type AgentUiInteractionInput = {
  organizationId: string;
  installationId: string;
  actorId: string;
  conversationId: string;
  messageId: string;
  blockId: string;
  actionId: string;
  idempotencyKey: string;
  values?: UiInteractionValues;
  context?: Record<string, unknown>;
  correlationId?: string;
};

export type AgentUiInteractionResult =
  | { kind: "navigate"; actionId: string; href: string }
  | { kind: "run"; actionId: string; blockId: string; accepted: AcceptedPlatformMessage; durable: boolean }
  | { kind: "resumed"; actionId: string; blockId: string; conversation: ConversationRecord; message: MessageRecord; run: RunRecord; signal: ExternalEventSignal; durable: boolean };

type CoordinatorDependencies = {
  conversations: Pick<ConversationRepository, "getConversation" | "getMessage">;
  runs: Pick<RunRepository, "getRun">;
  platformChat: Pick<PlatformChatRepository, "acceptMessage">;
  startWorkflow?: (runId: string) => Promise<void>;
  appendEvent?: (input: { organizationId: string; runId: string; installationId: string; eventType: string; payload: Record<string, unknown> }) => Promise<void>;
  signalExternalEvent?: (runId: string, signal: ExternalEventSignal) => Promise<void>;
  uiInteractions?: Pick<UiInteractionRepository, "claim" | "complete" | "fail">;
  isDynamicUiEnabled?: (organizationId: string, installationId: string) => Promise<boolean>;
  temporalEnabled: boolean;
};

function interactionError(message: string, statusCode: number, code: string): Error & { statusCode: number; code: string } {
  return Object.assign(new Error(message), { statusCode, code });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function displayTitle(block: AgentUi["blocks"][number]): string {
  return "title" in block && block.title ? block.title : block.type === "form" ? "Form" : block.type === "choice" ? "Choice" : "Result";
}

function ensureValues(values: unknown): UiInteractionValues {
  const parsed = record(values);
  if (Object.keys(parsed).length > 20) throw interactionError("Too many form values", 400, "ui_values_invalid");
  return parsed;
}

function formPrompt(block: Extract<AgentUi["blocks"][number], { type: "form" }>, values: UiInteractionValues): string {
  const lines: string[] = [];
  for (const field of block.fields) {
    const raw = values[field.id];
    if (field.type === "checkbox") {
      if (raw !== undefined && typeof raw !== "boolean") throw interactionError(`Invalid value for ${field.id}`, 400, "ui_values_invalid");
      if (field.required && raw !== true) throw interactionError(`${field.label} is required`, 400, "ui_values_invalid");
      if (raw !== undefined) lines.push(`${field.label}: ${raw ? "Yes" : "No"}`);
      continue;
    }

    const value = boundedString(raw, field.type === "select" ? 160 : field.maxLength);
    if (!value) {
      if (field.required) throw interactionError(`${field.label} is required`, 400, "ui_values_invalid");
      continue;
    }
    if (field.type === "select") {
      const option = field.options.find((candidate) => candidate.id === value || candidate.value === value);
      if (!option) throw interactionError(`Invalid choice for ${field.label}`, 400, "ui_values_invalid");
      lines.push(`${field.label}: ${option.value ?? option.label}`);
    } else {
      lines.push(`${field.label}: ${value}`);
    }
  }
  const submitted = lines.join("\n");
  if (!submitted) throw interactionError("Complete at least one field", 400, "ui_values_invalid");
  return `The user submitted the ${displayTitle(block).toLowerCase()} below. Use the existing platform capabilities and current authorization to continue.\n${submitted}`.slice(0, 20_000);
}

function choicePrompt(block: Extract<AgentUi["blocks"][number], { type: "choice" }>, actionId: string): string {
  const option = block.options.find((candidate) => candidate.id === actionId);
  if (!option) throw interactionError("Choice is no longer available", 409, "ui_action_stale");
  return `The user selected “${option.value ?? option.label}” from “${displayTitle(block)}”. Continue using the current platform state and authorization.`;
}

function actionForBlock(ui: AgentUi, blockId: string, actionId: string): { block: AgentUi["blocks"][number]; action?: UiAction; prompt?: string } {
  const block = ui.blocks.find((candidate) => candidate.id === blockId);
  if (!block) throw interactionError("UI block is no longer available", 409, "ui_action_stale");
  if (block.type === "choice") return { block, prompt: choicePrompt(block, actionId) };
  const action = "actions" in block ? block.actions?.find((candidate) => candidate.id === actionId) : undefined;
  if (!action) throw interactionError("UI action is no longer available", 409, "ui_action_stale");
  return { block, action };
}

export class AgentUiInteractionCoordinator {
  public constructor(private readonly dependencies: CoordinatorDependencies) {}

  public async resolveAndExecute(input: AgentUiInteractionInput): Promise<AgentUiInteractionResult> {
    return withSpan("agent.ui.interaction", {
      "kasitek.ui.action": input.actionId.slice(0, 80),
      "kasitek.ui.block": input.blockId.slice(0, 80),
    }, async () => {
      if (this.dependencies.isDynamicUiEnabled && !(await this.dependencies.isDynamicUiEnabled(input.organizationId, input.installationId))) {
        recordDynamicUiInteraction({ outcome: "rejected", action: "disabled" });
        throw interactionError("Dynamic UI interactions are disabled", 409, "dynamic_ui_disabled");
      }
      const conversation = await this.dependencies.conversations.getConversation(input.organizationId, input.conversationId);
      if (!conversation
        || conversation.installation_id !== input.installationId
        || conversation.owner_actor_id !== input.actorId
        || conversation.status !== "active") {
        recordDynamicUiInteraction({ outcome: "rejected", action: "unknown" });
        throw interactionError("Conversation is not available", 404, "conversation_not_found");
      }
      const message = await this.dependencies.conversations.getMessage(input.organizationId, input.conversationId, input.messageId);
      if (!message || message.direction !== "outbound" || message.source_channel !== "platform") {
        recordDynamicUiInteraction({ outcome: "rejected", action: "unknown" });
        throw interactionError("UI message is not available", 404, "ui_message_not_found");
      }
      const parsedUi = agentUiSchema.safeParse(message.content.ui);
      if (!parsedUi.success) {
        recordDynamicUiInteraction({ outcome: "rejected", action: "invalid" });
        throw interactionError("UI view is no longer available", 409, "ui_action_stale");
      }
      const { block, action, prompt: choiceInteractionPrompt } = actionForBlock(parsedUi.data, input.blockId, input.actionId);
      if (action?.expiresAt && Date.parse(action.expiresAt) <= Date.now()) {
        recordDynamicUiInteraction({ outcome: "rejected", action: action.kind });
        throw interactionError("UI action has expired", 409, "ui_action_expired");
      }
      if (!action && block.type !== "choice") {
        recordDynamicUiInteraction({ outcome: "rejected", action: "invalid" });
        throw interactionError("UI action is invalid", 409, "ui_action_stale");
      }

      if (action?.kind === "navigate") {
        recordDynamicUiInteraction({ outcome: "navigated", action: action.kind });
        return { kind: "navigate", actionId: action.id, href: action.href! };
      }

      if (action?.kind === "resume") {
        if (!message.run_id) throw interactionError("The waiting run is no longer available", 409, "run_not_waiting");
        const run = await this.dependencies.runs.getRun(input.organizationId, message.run_id);
        if (!run || run.installation_id !== input.installationId || run.conversation_id !== input.conversationId) {
          throw interactionError("The waiting run is no longer available", 409, "run_not_waiting");
        }
        if (run.status !== "awaiting_external_event" && run.status !== "awaiting_human") {
          throw interactionError("The run is no longer waiting for this action", 409, "run_not_waiting");
        }
        if (!this.dependencies.signalExternalEvent) throw interactionError("External-event resume is unavailable", 503, "temporal_not_configured");
        const values = ensureValues(input.values);
        let receipt: Awaited<ReturnType<UiInteractionRepository["claim"]>>["receipt"] | undefined;
        if (this.dependencies.uiInteractions) {
          const claimed = await this.dependencies.uiInteractions.claim({
            organization_id: input.organizationId,
            installation_id: input.installationId,
            idempotency_key: input.idempotencyKey,
            actor_id: input.actorId,
            conversation_id: input.conversationId,
            message_id: input.messageId,
            block_id: input.blockId,
            action_id: input.actionId,
            event_key: action.eventKey!,
            values,
          });
          receipt = claimed.receipt;
          if (!claimed.created) {
            if (receipt.block_id !== input.blockId || receipt.action_id !== input.actionId || receipt.event_key !== action.eventKey) {
              throw interactionError("Idempotency key was already used for another UI action", 409, "ui_idempotency_conflict");
            }
            if (receipt.status === "started") throw interactionError("This UI action is already being processed", 409, "ui_interaction_in_progress");
            if (receipt.status === "completed" && receipt.run_id) {
              const existingRun = await this.dependencies.runs.getRun(input.organizationId, receipt.run_id);
              if (existingRun) {
                recordDynamicUiInteraction({ outcome: "idempotent", action: action.kind });
                return { kind: "resumed", actionId: action.id, blockId: block.id, conversation, message, run: existingRun, signal: { key: receipt.event_key, payload: receipt.values }, durable: this.dependencies.temporalEnabled };
              }
            }
          }
        }
        const signal: ExternalEventSignal = { key: action.eventKey!, payload: values };
        try {
          await this.dependencies.signalExternalEvent(run.id, signal);
          if (receipt && this.dependencies.uiInteractions) await this.dependencies.uiInteractions.complete({ organizationId: input.organizationId, installationId: input.installationId, idempotencyKey: input.idempotencyKey, runId: run.id });
        } catch (error) {
          if (receipt && this.dependencies.uiInteractions) await this.dependencies.uiInteractions.fail({ organizationId: input.organizationId, installationId: input.installationId, idempotencyKey: input.idempotencyKey });
          throw error;
        }
        recordDynamicUiInteraction({ outcome: "resumed", action: action.kind });
        return { kind: "resumed", actionId: action.id, blockId: block.id, conversation, message, run, signal, durable: this.dependencies.temporalEnabled };
      }

      let messageText: string;
      if (block.type === "choice") {
        messageText = choiceInteractionPrompt!;
      } else if (action?.kind === "follow_up") {
        messageText = action.prompt!;
      } else if (action?.kind === "refresh") {
        messageText = "Refresh the information shown in the previous result using the current platform state.";
      } else if (action?.kind === "submit" && block.type === "form") {
        messageText = formPrompt(block, ensureValues(input.values));
      } else {
        throw interactionError("UI action is invalid", 409, "ui_action_stale");
      }

      const accepted = await this.dependencies.platformChat.acceptMessage({
        organizationId: input.organizationId,
        installationId: input.installationId,
        actorId: input.actorId,
        correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
        message: messageText,
        content: {
          text: messageText,
          uiInteraction: {
            sourceMessageId: input.messageId,
            blockId: input.blockId,
            actionId: input.actionId,
          },
        },
        context: input.context,
        conversationId: input.conversationId,
      });
      const durable = this.dependencies.temporalEnabled && Boolean(this.dependencies.startWorkflow);
      if (durable && this.dependencies.startWorkflow && accepted.created && accepted.run?.status === "received") {
        try {
          await this.dependencies.startWorkflow(accepted.run.id);
        } catch (error) {
          await this.dependencies.appendEvent?.({
            organizationId: input.organizationId,
            runId: accepted.run.id,
            installationId: input.installationId,
            eventType: "run.dispatch_failed",
            payload: { message: error instanceof Error ? error.message : "Unable to dispatch workflow", retryable: true },
          });
          throw error;
        }
      }
      recordDynamicUiInteraction({ outcome: accepted.created ? "accepted" : "idempotent", action: action?.kind ?? "choice" });
      return { kind: "run", actionId: input.actionId, blockId: block.id, accepted, durable };
    });
  }
}
