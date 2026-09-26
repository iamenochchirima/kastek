import { createHash } from "node:crypto";
import type { ModelMessage, ModelToolCall } from "../model/types";

/**
 * The provider-facing tool id is not a durable operation identity. Providers
 * are allowed to reuse short ids across model turns, while a run may execute
 * the same capability more than once. Runtime code must therefore correlate a
 * call and its result with this identity first and only fall back to the
 * provider id for legacy messages.
 */
export function toolOperationIdentity(value: Pick<ModelToolCall, "id" | "runtimeOperationId"> | Pick<ModelMessage, "toolCallId" | "runtimeOperationId">): string | undefined {
  if (typeof value.runtimeOperationId === "string" && value.runtimeOperationId.trim()) return value.runtimeOperationId;
  if ("id" in value && typeof value.id === "string" && value.id.trim()) return value.id;
  if ("toolCallId" in value && typeof value.toolCallId === "string" && value.toolCallId.trim()) return value.toolCallId;
  return undefined;
}

export function toolResultMatchesCall(result: ModelMessage, call: ModelToolCall): boolean {
  const resultIdentity = toolOperationIdentity(result);
  const callIdentity = toolOperationIdentity(call);
  return Boolean(resultIdentity && callIdentity && resultIdentity === callIdentity);
}

export function cloneToolCall(call: ModelToolCall): ModelToolCall {
  return { ...call, arguments: { ...call.arguments } };
}

export function cloneModelMessage(message: ModelMessage): ModelMessage {
  return {
    ...message,
    ...(message.toolCalls ? { toolCalls: message.toolCalls.map(cloneToolCall) } : {}),
  };
}

/** Content-address the ordered runtime transcript for checkpoint/replay checks. */
export function transcriptDigest(messages: readonly ModelMessage[]): string {
  // Checkpoints are persisted as JSONB. PostgreSQL is free to emit object
  // keys in a different order than the provider response, so hashing the raw
  // JSON string would make an otherwise identical transcript fail recovery.
  return createHash("sha256").update(JSON.stringify(canonicalize(messages))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

export interface ModelTranscriptUnit {
  readonly messages: ModelMessage[];
  readonly protectedPair: boolean;
  readonly startIndex: number;
  readonly endIndex: number;
}

export interface TranscriptValidationIssue {
  readonly code: "missing_tool_result" | "orphan_tool_result" | "duplicate_tool_result" | "out_of_order_tool_result" | "missing_tool_call_identity" | "duplicate_tool_call_identity";
  readonly index: number;
  readonly operationId?: string;
}

/**
 * Validate the provider-facing transcript before any context or provider
 * projection is built. This deliberately reports corruption instead of
 * dropping an orphan or inventing a successful-looking result.
 */
export function validateModelTranscript(messages: readonly ModelMessage[]): TranscriptValidationIssue[] {
  const issues: TranscriptValidationIssue[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "tool") {
      issues.push({ code: "orphan_tool_result", index, ...(toolOperationIdentity(message) ? { operationId: toolOperationIdentity(message) } : {}) });
      continue;
    }
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const calls = new Map<string, ModelToolCall>();
    for (const call of message.toolCalls) {
      const operationId = toolOperationIdentity(call);
      if (!operationId) {
        issues.push({ code: "missing_tool_call_identity", index });
      } else if (calls.has(operationId)) {
        issues.push({ code: "duplicate_tool_call_identity", index, operationId });
      } else {
        calls.set(operationId, call);
      }
    }
    const seen = new Set<string>();
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool") {
      const result = messages[cursor]!;
      const operationId = toolOperationIdentity(result);
      if (!operationId || !calls.has(operationId)) {
        issues.push({ code: "out_of_order_tool_result", index: cursor, ...(operationId ? { operationId } : {}) });
      } else if (seen.has(operationId)) {
        issues.push({ code: "duplicate_tool_result", index: cursor, operationId });
      } else {
        seen.add(operationId);
      }
      cursor += 1;
    }
    for (const operationId of calls.keys()) {
      if (!seen.has(operationId)) issues.push({ code: "missing_tool_result", index, operationId });
    }
    index = cursor - 1;
  }
  return issues;
}

/** Build the only message-unit representation used by planning and compaction. */
export function buildTranscriptUnits(messages: readonly ModelMessage[], options: { clone?: boolean } = {}): ModelTranscriptUnit[] {
  const units: ModelTranscriptUnit[] = [];
  for (let index = 0; index < messages.length;) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      units.push({ messages: [options.clone ? cloneModelMessage(message) : message], protectedPair: false, startIndex: index, endIndex: index });
      index += 1;
      continue;
    }
    const expected = new Set(message.toolCalls.map((call) => toolOperationIdentity(call)).filter((value): value is string => Boolean(value)));
    const pair: ModelMessage[] = [options.clone ? cloneModelMessage(message) : message];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]?.role === "tool" && expected.has(toolOperationIdentity(messages[cursor]!) ?? "")) {
      pair.push(options.clone ? cloneModelMessage(messages[cursor]!) : messages[cursor]!);
      cursor += 1;
    }
    units.push({ messages: pair, protectedPair: pair.length > 1, startIndex: index, endIndex: cursor - 1 });
    index = cursor;
  }
  return units;
}
