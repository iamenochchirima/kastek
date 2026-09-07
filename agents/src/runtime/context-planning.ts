import type { ModelMessage, ModelToolDefinition } from "../model/types";

/**
 * A provider-aware request planner for model-facing context.
 *
 * Planning uses a conservative character estimate. It is deliberately not a
 * billing tokenizer and never replaces provider-reported usage. The planner
 * keeps system messages and recent tool-call/result pairs intact, then drops
 * older message units when the request needs compaction.
 */

export type ContextBudgetCategory =
  | "system"
  | "history"
  | "current_message"
  | "tool_results"
  | "tool_schemas"
  | "output_reservation"
  | "safety_margin";

export type ContextPlanStatus = "fits" | "compacted" | "rejected";

export type ContextPlanRejection =
  | "invalid_provider_profile"
  | "system_context_exceeds_input_budget"
  | "current_message_cannot_fit";

export interface ProviderContextProfile {
  /** Provider identifier used for diagnostics and provider-specific limits. */
  readonly provider: string;
  /** Model identifier used for diagnostics. */
  readonly model: string;
  /** Context window reported by the provider/model registry. */
  readonly contextWindowTokens: number;
  /** Provider maximum for generated tokens, when known. */
  readonly maxOutputTokens?: number;
  /** Extra input capacity kept unused to cover framing/tokenizer variance. */
  readonly safetyMarginTokens?: number;
  /** Approximate characters per token. The default is intentionally conservative. */
  readonly charsPerToken?: number;
  /** Approximate per-message framing overhead. */
  readonly messageOverheadTokens?: number;
}

export interface ContextPlanningPolicy {
  /** Requested response budget before the provider cap is applied. */
  readonly requestedOutputTokens: number;
  /** Maximum approximate schema footprint admitted to the request. */
  readonly maxToolSchemaTokens: number;
  /** Maximum approximate content retained for one tool result. */
  readonly maxToolResultTokens: number;
  /** Maximum number of message units retained after system messages. */
  readonly maxMessageUnits?: number;
}

export interface ContextBudgetCategories {
  readonly system: number;
  readonly history: number;
  readonly current_message: number;
  readonly tool_results: number;
  readonly tool_schemas: number;
  readonly output_reservation: number;
  readonly safety_margin: number;
}

export interface ApproximateTokenAccounting {
  readonly method: "approximate_characters";
  readonly charsPerToken: number;
  readonly categories: ContextBudgetCategories;
  readonly estimatedInputTokens: number;
  readonly reservedRequestTokens: number;
  readonly providerContextWindowTokens: number;
  readonly inputBudgetTokens: number;
}

export interface ContextPlanDiagnostics {
  readonly reasons: readonly string[];
  readonly omittedMessageCount: number;
  readonly omittedToolCount: number;
  readonly truncatedToolResultCount: number;
  readonly protectedPairCount: number;
  readonly selectedMessageUnitCount: number;
}

export interface ContextPlanBase {
  readonly provider: string;
  readonly model: string;
  readonly status: ContextPlanStatus;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly accounting: ApproximateTokenAccounting;
  readonly diagnostics: ContextPlanDiagnostics;
}

export interface ContextPlanAccepted extends ContextPlanBase {
  readonly status: "fits" | "compacted";
  readonly rejection: undefined;
}

export interface ContextPlanRejected extends ContextPlanBase {
  readonly status: "rejected";
  readonly rejection: {
    readonly code: ContextPlanRejection;
    readonly message: string;
  };
}

export type ContextPlan = ContextPlanAccepted | ContextPlanRejected;

export interface ContextPlanInput {
  readonly profile: ProviderContextProfile;
  readonly policy: ContextPlanningPolicy;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
  /** Defaults to the newest user message. */
  readonly currentMessageIndex?: number;
}

export interface ProviderReportedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens?: number;
}

export type ContextAccountingStatus = "accepted" | "provider_overrun" | "invalid_usage";

export interface ContextUsageAccounting {
  readonly status: ContextAccountingStatus;
  readonly source: "provider_reported";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly plannedInputTokens: number;
  readonly plannedOutputReservation: number;
  readonly inputOverrunTokens: number;
  readonly outputOverrunTokens: number;
  readonly totalOverrunTokens: number;
  readonly issues: readonly string[];
}

const DEFAULT_CHARS_PER_TOKEN = 4;
const DEFAULT_MESSAGE_OVERHEAD_TOKENS = 8;
const DEFAULT_SAFETY_MARGIN_TOKENS = 256;
const DEFAULT_MAX_TOOL_SCHEMA_TOKENS = 2_000;
const DEFAULT_MAX_TOOL_RESULT_TOKENS = 1_500;
const MINIMUM_MESSAGE_TOKENS = 1;

export function planProviderRequest(input: ContextPlanInput): ContextPlan {
  const profile = normalizeProfile(input.profile);
  const policy = normalizePolicy(input.policy);
  const charsPerToken = profile.charsPerToken;
  const tools = selectTools(input.tools ?? [], policy.maxToolSchemaTokens, charsPerToken);
  const normalizedMessages = limitToolResults(input.messages, policy.maxToolResultTokens, charsPerToken);
  const systemMessages = normalizedMessages.messages.filter((message) => message.role === "system");
  const bodyMessages = normalizedMessages.messages.filter((message) => message.role !== "system");
  const systemTokens = sumMessages(systemMessages, charsPerToken, profile.messageOverheadTokens);
  const toolSchemaTokens = sumTools(tools.selected, charsPerToken);
  const outputReservation = Math.min(policy.requestedOutputTokens, profile.maxOutputTokens ?? policy.requestedOutputTokens);
  const inputBudgetTokens = profile.contextWindowTokens - outputReservation - profile.safetyMarginTokens;
  const reasons: string[] = [];

  if (tools.omittedCount > 0) reasons.push("tool_schema_budget");
  if (normalizedMessages.truncatedToolResultCount > 0) reasons.push("tool_result_budget");
  if (outputReservation < policy.requestedOutputTokens) reasons.push("provider_output_cap");

  const emptyDiagnostics = (overrides: Partial<ContextPlanDiagnostics> = {}): ContextPlanDiagnostics => ({
    reasons,
    omittedMessageCount: 0,
    omittedToolCount: tools.omittedCount,
    truncatedToolResultCount: normalizedMessages.truncatedToolResultCount,
    protectedPairCount: 0,
    selectedMessageUnitCount: 0,
    ...overrides,
  });

  if (!profile.valid) {
    return rejectedPlan(input.profile, tools.selected, [], emptyDiagnostics(), {
      code: "invalid_provider_profile",
      message: "The provider context profile must contain a positive context window and non-negative budgets.",
    }, charsPerToken, systemTokens, 0, 0, 0, toolSchemaTokens, outputReservation);
  }

  if (inputBudgetTokens < systemTokens + toolSchemaTokens) {
    reasons.push("system_context_exceeds_input_budget");
    return rejectedPlan(input.profile, tools.selected, systemMessages, emptyDiagnostics({ reasons }), {
      code: "system_context_exceeds_input_budget",
      message: "System instructions and selected tool schemas exceed the provider input budget.",
    }, charsPerToken, systemTokens, 0, 0, 0, toolSchemaTokens, outputReservation);
  }

  const units = buildMessageUnits(bodyMessages);
  const selectedUnits = selectRecentUnits({
    units,
    systemTokens,
    toolSchemaTokens,
    inputBudgetTokens,
    charsPerToken,
    messageOverheadTokens: profile.messageOverheadTokens,
    maxMessageUnits: policy.maxMessageUnits,
    currentMessageIndex: resolveCurrentMessageIndex(normalizedMessages.messages, input.currentMessageIndex),
  });

  if (selectedUnits.status === "rejected") {
    reasons.push(selectedUnits.code);
    return rejectedPlan(input.profile, tools.selected, systemMessages, emptyDiagnostics({
      reasons,
      omittedMessageCount: bodyMessages.length,
      protectedPairCount: selectedUnits.protectedPairCount,
      selectedMessageUnitCount: selectedUnits.units.length,
    }), {
      code: selectedUnits.code,
      message: selectedUnits.message,
    }, charsPerToken, systemTokens, 0, 0, 0, toolSchemaTokens, outputReservation);
  }

  const selectedMessages = [...systemMessages, ...selectedUnits.units.flatMap((unit) => unit.messages)];
  const categories = { ...categorizeMessages(selectedMessages, charsPerToken, profile.messageOverheadTokens), tool_schemas: toolSchemaTokens };
  const omittedMessageCount = Math.max(0, bodyMessages.length - selectedUnits.units.reduce((total, unit) => total + unit.messages.length, 0));
  if (omittedMessageCount > 0) reasons.push("history_compacted");
  if (reasons.length > 0 && !reasons.includes("history_compacted") && !reasons.includes("tool_schema_budget") && !reasons.includes("tool_result_budget")) {
    reasons.push("request_adjusted");
  }

  const status: ContextPlanStatus = omittedMessageCount > 0 ? "compacted" : "fits";
  return {
    provider: input.profile.provider,
    model: input.profile.model,
    status,
    rejection: undefined,
    messages: selectedMessages,
    tools: tools.selected,
    accounting: createAccounting(categories, profile, outputReservation, charsPerToken),
    diagnostics: {
      reasons,
      omittedMessageCount,
      omittedToolCount: tools.omittedCount,
      truncatedToolResultCount: normalizedMessages.truncatedToolResultCount,
      protectedPairCount: selectedUnits.protectedPairCount,
      selectedMessageUnitCount: selectedUnits.units.length,
    },
  };
}

export function accountProviderUsage(plan: ContextPlan, usage: ProviderReportedUsage): ContextUsageAccounting {
  const issues: string[] = [];
  if (!isValidUsageNumber(usage.inputTokens)) issues.push("invalid_input_tokens");
  if (!isValidUsageNumber(usage.outputTokens)) issues.push("invalid_output_tokens");
  if (usage.totalTokens !== undefined && !isValidUsageNumber(usage.totalTokens)) issues.push("invalid_total_tokens");
  if (issues.length > 0) {
    return {
      status: "invalid_usage",
      source: "provider_reported",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      plannedInputTokens: plan.accounting.estimatedInputTokens,
      plannedOutputReservation: plan.accounting.categories.output_reservation,
      inputOverrunTokens: 0,
      outputOverrunTokens: 0,
      totalOverrunTokens: 0,
      issues,
    };
  }

  const totalTokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
  const inputOverrunTokens = Math.max(0, usage.inputTokens - plan.accounting.inputBudgetTokens);
  const outputOverrunTokens = Math.max(0, usage.outputTokens - plan.accounting.categories.output_reservation);
  const totalOverrunTokens = Math.max(0, totalTokens - plan.accounting.providerContextWindowTokens);
  if (inputOverrunTokens > 0) issues.push("provider_input_exceeded_planned_budget");
  if (outputOverrunTokens > 0) issues.push("provider_output_exceeded_reserved_budget");
  if (totalOverrunTokens > 0) issues.push("provider_total_exceeded_context_window");
  return {
    status: issues.length > 0 ? "provider_overrun" : "accepted",
    source: "provider_reported",
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens,
    plannedInputTokens: plan.accounting.estimatedInputTokens,
    plannedOutputReservation: plan.accounting.categories.output_reservation,
    inputOverrunTokens,
    outputOverrunTokens,
    totalOverrunTokens,
    issues,
  };
}

export function estimateApproximateTokens(value: unknown, charsPerToken = DEFAULT_CHARS_PER_TOKEN): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return Math.max(MINIMUM_MESSAGE_TOKENS, Math.ceil(serialized.length / normalizeCharsPerToken(charsPerToken)));
}

interface NormalizedProfile {
  readonly provider: string;
  readonly model: string;
  readonly contextWindowTokens: number;
  readonly maxOutputTokens: number | undefined;
  readonly safetyMarginTokens: number;
  readonly charsPerToken: number;
  readonly messageOverheadTokens: number;
  readonly valid: boolean;
}

function normalizeProfile(profile: ProviderContextProfile): NormalizedProfile {
  const contextWindowTokens = finiteInteger(profile.contextWindowTokens);
  const maxOutputTokens = profile.maxOutputTokens === undefined ? undefined : finiteInteger(profile.maxOutputTokens);
  const safetyMarginTokens = profile.safetyMarginTokens === undefined ? DEFAULT_SAFETY_MARGIN_TOKENS : finiteInteger(profile.safetyMarginTokens);
  const charsPerToken = profile.charsPerToken === undefined ? DEFAULT_CHARS_PER_TOKEN : normalizeCharsPerToken(profile.charsPerToken);
  const messageOverheadTokens = profile.messageOverheadTokens === undefined ? DEFAULT_MESSAGE_OVERHEAD_TOKENS : finiteInteger(profile.messageOverheadTokens);
  return {
    provider: profile.provider,
    model: profile.model,
    contextWindowTokens,
    maxOutputTokens,
    safetyMarginTokens,
    charsPerToken,
    messageOverheadTokens,
    valid: Boolean(profile.provider && profile.model && contextWindowTokens > 0 && (maxOutputTokens === undefined || maxOutputTokens > 0) && safetyMarginTokens >= 0 && messageOverheadTokens >= 0),
  };
}

function normalizePolicy(policy: ContextPlanningPolicy): Required<ContextPlanningPolicy> {
  return {
    requestedOutputTokens: Math.max(1, finiteInteger(policy.requestedOutputTokens)),
    maxToolSchemaTokens: Math.max(0, finiteInteger(policy.maxToolSchemaTokens ?? DEFAULT_MAX_TOOL_SCHEMA_TOKENS)),
    maxToolResultTokens: Math.max(1, finiteInteger(policy.maxToolResultTokens ?? DEFAULT_MAX_TOOL_RESULT_TOKENS)),
    maxMessageUnits: policy.maxMessageUnits === undefined ? Number.MAX_SAFE_INTEGER : Math.max(0, finiteInteger(policy.maxMessageUnits)),
  };
}

function selectTools(tools: readonly ModelToolDefinition[], maxTokens: number, charsPerToken: number): { selected: ModelToolDefinition[]; omittedCount: number } {
  const selected: ModelToolDefinition[] = [];
  let usedTokens = 0;
  for (const tool of tools) {
    const candidateTokens = estimateApproximateTokens(tool, charsPerToken);
    if (usedTokens + candidateTokens > maxTokens) continue;
    selected.push(tool);
    usedTokens += candidateTokens;
  }
  return { selected, omittedCount: tools.length - selected.length };
}

function limitToolResults(messages: readonly ModelMessage[], maxTokens: number, charsPerToken: number): { messages: ModelMessage[]; truncatedToolResultCount: number } {
  let truncatedToolResultCount = 0;
  const limited = messages.map((message) => {
    if (message.role !== "tool" || estimateApproximateTokens(message.content, charsPerToken) <= maxTokens) return message;
    truncatedToolResultCount += 1;
    return { ...message, content: truncateText(message.content, maxTokens, charsPerToken) };
  });
  return { messages: limited, truncatedToolResultCount };
}

interface MessageUnit {
  readonly messages: ModelMessage[];
  readonly protectedPair: boolean;
}

function buildMessageUnits(messages: readonly ModelMessage[]): MessageUnit[] {
  const units: MessageUnit[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      units.push({ messages: [message], protectedPair: false });
      index += 1;
      continue;
    }
    const expected = new Set(message.toolCalls.map((call) => call.id));
    const pair: ModelMessage[] = [message];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool" && expected.has(messages[cursor]?.toolCallId ?? "")) {
      pair.push(messages[cursor]!);
      cursor += 1;
    }
    units.push({ messages: pair, protectedPair: pair.length > 1 });
    index = cursor;
  }
  return units;
}

function selectRecentUnits(input: {
  units: readonly MessageUnit[];
  systemTokens: number;
  toolSchemaTokens: number;
  inputBudgetTokens: number;
  charsPerToken: number;
  messageOverheadTokens: number;
  maxMessageUnits: number;
  currentMessageIndex: number;
}): { status: "selected"; units: MessageUnit[]; protectedPairCount: number } | { status: "rejected"; code: "current_message_cannot_fit"; message: string; units: MessageUnit[]; protectedPairCount: number } {
  const available = input.inputBudgetTokens - input.systemTokens - input.toolSchemaTokens;
  const selected: MessageUnit[] = [];
  let usedTokens = 0;
  let protectedPairCount = 0;
  let selectedUnits = 0;
  for (let index = input.units.length - 1; index >= 0; index -= 1) {
    if (selectedUnits >= input.maxMessageUnits) break;
    // An explicit current-message index is authoritative. Do not spend the
    // tail budget on rows after it and then accidentally omit the turn the
    // caller marked as current.
    if (input.currentMessageIndex >= 0 && index > input.currentMessageIndex) continue;
    const unit = input.units[index]!;
    const unitTokens = sumMessages(unit.messages, input.charsPerToken, input.messageOverheadTokens);
    if (usedTokens + unitTokens > available) {
      if (selected.length === 0 && input.currentMessageIndex >= 0 && input.currentMessageIndex === index) {
        const room = Math.max(0, available - usedTokens);
        const current = unit.messages.length === 1 && unit.messages[0]?.role === "user"
          ? { ...unit.messages[0], content: truncateText(unit.messages[0].content, room, input.charsPerToken) }
          : undefined;
        if (current && sumMessages([current], input.charsPerToken, input.messageOverheadTokens) <= room && current.content.length > 0) {
          selected.push({ messages: [current], protectedPair: false });
          selectedUnits += 1;
          usedTokens += sumMessages([current], input.charsPerToken, input.messageOverheadTokens);
          break;
        }
        return { status: "rejected", code: "current_message_cannot_fit", message: "The current user message cannot fit after provider overhead and safety margin.", units: [], protectedPairCount: 0 };
      }
      break;
    }
    selected.push(unit);
    selectedUnits += 1;
    usedTokens += unitTokens;
    if (unit.protectedPair) protectedPairCount += 1;
  }
  selected.reverse();
  return { status: "selected", units: selected, protectedPairCount };
}

function resolveCurrentMessageIndex(messages: readonly ModelMessage[], explicitIndex: number | undefined): number {
  let fullIndex = -1;
  if (explicitIndex !== undefined && Number.isInteger(explicitIndex) && explicitIndex >= 0 && explicitIndex < messages.length) {
    fullIndex = explicitIndex;
  } else {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        fullIndex = index;
        break;
      }
    }
  }
  if (fullIndex < 0) return -1;
  return messages.slice(0, fullIndex + 1).filter((message) => message.role !== "system").length - 1;
}

function categorizeMessages(messages: readonly ModelMessage[], charsPerToken: number, messageOverheadTokens: number): ContextBudgetCategories {
  const categories = { system: 0, history: 0, current_message: 0, tool_results: 0, tool_schemas: 0, output_reservation: 0, safety_margin: 0 };
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      currentUserIndex = index;
      break;
    }
  }
  messages.forEach((message, index) => {
    const tokens = sumMessages([message], charsPerToken, messageOverheadTokens);
    if (message.role === "system") categories.system += tokens;
    else if (message.role === "tool") categories.tool_results += tokens;
    else if (index === currentUserIndex) categories.current_message += tokens;
    else categories.history += tokens;
  });
  return categories;
}

function createAccounting(categories: ContextBudgetCategories, profile: NormalizedProfile, outputReservation: number, charsPerToken: number): ApproximateTokenAccounting {
  const withReservation: ContextBudgetCategories = { ...categories, output_reservation: outputReservation, safety_margin: profile.safetyMarginTokens };
  const estimatedInputTokens = categories.system + categories.history + categories.current_message + categories.tool_results + categories.tool_schemas;
  return {
    method: "approximate_characters",
    charsPerToken,
    categories: withReservation,
    estimatedInputTokens,
    reservedRequestTokens: estimatedInputTokens + outputReservation + profile.safetyMarginTokens,
    providerContextWindowTokens: profile.contextWindowTokens,
    inputBudgetTokens: profile.contextWindowTokens - outputReservation - profile.safetyMarginTokens,
  };
}

function rejectedPlan(
  profile: ProviderContextProfile,
  tools: readonly ModelToolDefinition[],
  messages: readonly ModelMessage[],
  diagnostics: ContextPlanDiagnostics,
  rejection: ContextPlanRejected["rejection"],
  charsPerToken: number,
  systemTokens: number,
  historyTokens: number,
  currentMessageTokens: number,
  toolResultTokens: number,
  toolSchemaTokens: number,
  outputReservation: number,
): ContextPlanRejected {
  const normalized = normalizeProfile(profile);
  const categories: ContextBudgetCategories = {
    system: systemTokens,
    history: historyTokens,
    current_message: currentMessageTokens,
    tool_results: toolResultTokens,
    tool_schemas: toolSchemaTokens,
    output_reservation: outputReservation,
    safety_margin: normalized.safetyMarginTokens,
  };
  const estimatedInputTokens = systemTokens + historyTokens + currentMessageTokens + toolResultTokens + toolSchemaTokens;
  return {
    provider: profile.provider,
    model: profile.model,
    status: "rejected",
    rejection,
    messages,
    tools,
    accounting: {
      method: "approximate_characters",
      charsPerToken,
      categories,
      estimatedInputTokens,
      reservedRequestTokens: estimatedInputTokens + outputReservation + normalized.safetyMarginTokens,
      providerContextWindowTokens: normalized.contextWindowTokens,
      inputBudgetTokens: normalized.contextWindowTokens - outputReservation - normalized.safetyMarginTokens,
    },
    diagnostics,
  };
}

function sumMessages(messages: readonly ModelMessage[], charsPerToken: number, messageOverheadTokens: number): number {
  return messages.reduce((total, message) => total + messageTokens(message, charsPerToken, messageOverheadTokens), 0);
}

function messageTokens(message: ModelMessage, charsPerToken: number, messageOverheadTokens: number): number {
  const toolCalls = message.toolCalls?.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments }));
  return messageOverheadTokens + estimateApproximateTokens({ role: message.role, name: message.name, toolCallId: message.toolCallId, content: message.content, toolCalls }, charsPerToken);
}

function sumTools(tools: readonly ModelToolDefinition[], charsPerToken: number): number {
  return tools.reduce((total, tool) => total + estimateApproximateTokens(tool, charsPerToken), 0);
}

function truncateText(value: string, maxTokens: number, charsPerToken: number): string {
  const maxChars = Math.max(1, Math.floor(maxTokens * charsPerToken));
  if (value.length <= maxChars) return value;
  const marker = "\n[content truncated by context planner]";
  if (maxChars <= marker.length) return value.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function isValidUsageNumber(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function finiteInteger(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : -1;
}

function normalizeCharsPerToken(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_CHARS_PER_TOKEN;
}
