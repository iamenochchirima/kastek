import { createHash } from "node:crypto";
import type { SessionTranscriptProjection } from "../db/repositories/session-transcript-repository";
import type { ModelMessage } from "../model/types";
import type { DurableToolCall, DurableToolCallResult } from "../temporal/contracts";
import { cloneModelMessage } from "./transcript";

export interface TranscriptSourceIdentity {
  generation: number;
  cursor: number;
  headDigest: string;
  projectionDigest: string;
}

export function transcriptSourceIdentity(projection: SessionTranscriptProjection): TranscriptSourceIdentity {
  return {
    generation: projection.context.generation,
    cursor: projection.sourceCursor,
    headDigest: projection.sourceDigest,
    projectionDigest: projection.activeProjectionDigest,
  };
}

export function assertTranscriptSource(
  projection: SessionTranscriptProjection,
  expected: TranscriptSourceIdentity | undefined,
): void {
  if (!expected) return;
  const actual = transcriptSourceIdentity(projection);
  if (actual.generation !== expected.generation
    || actual.cursor !== expected.cursor
    || actual.headDigest !== expected.headDigest
    || actual.projectionDigest !== expected.projectionDigest) {
    throw new Error("SESSION_TRANSCRIPT_SOURCE_CONFLICT");
  }
}

export function assistantToolCallMessage(input: {
  assistantMessage?: ModelMessage;
  calls: readonly DurableToolCall[];
}): ModelMessage {
  const fallback: ModelMessage = {
    role: "assistant",
    content: "",
    toolCalls: input.calls.map((call) => ({
      id: call.providerToolCallId ?? call.id,
      runtimeOperationId: call.id,
      name: call.name,
      arguments: { ...call.arguments },
    })),
  };
  const assistantMessage = input.assistantMessage;
  if (!assistantMessage || assistantMessage.role !== "assistant" || !assistantMessage.toolCalls?.length) return fallback;
  if (assistantMessage.toolCalls.length !== input.calls.length) throw new Error("SESSION_TRANSCRIPT_TOOL_CALL_BATCH_CONFLICT");
  for (const [index, call] of input.calls.entries()) {
    const providerCall = assistantMessage.toolCalls[index];
    if (!providerCall
      || providerCall.id !== (call.providerToolCallId ?? call.id)
      || (providerCall.runtimeOperationId !== undefined && providerCall.runtimeOperationId !== call.id)
      || providerCall.name !== call.name
      || JSON.stringify(providerCall.arguments) !== JSON.stringify(call.arguments)) {
      throw new Error("SESSION_TRANSCRIPT_TOOL_CALL_BATCH_CONFLICT");
    }
  }
  return {
    ...cloneModelMessage(assistantMessage),
    toolCalls: assistantMessage.toolCalls.map((providerCall, index) => ({
      ...providerCall,
      runtimeOperationId: input.calls[index]!.id,
      arguments: { ...providerCall.arguments },
    })),
  };
}

export function durableToolResultContent(result: DurableToolCallResult): string {
  const value = result.status === "completed"
    ? result.output
    : {
        ok: false,
        error: result.error ?? { code: "TOOL_FAILED", message: "Tool failed" },
      };
  return JSON.stringify(value) ?? "null";
}

export function durableToolResultMessage(result: DurableToolCallResult): ModelMessage {
  return {
    role: "tool",
    name: result.name,
    toolCallId: result.providerToolCallId,
    runtimeOperationId: result.id,
    content: durableToolResultContent(result),
  };
}

const MAX_CHECKPOINT_TOOL_RESULT_BYTES = 4_096;

/**
 * Keep the workflow checkpoint recoverable when a capability returns a large
 * payload. The canonical transcript keeps the complete redacted result; this
 * model-facing checkpoint carries a bounded preview and a stable lookup key.
 */
export function checkpointToolResultMessage(result: DurableToolCallResult): ModelMessage {
  const canonical = durableToolResultMessage(result);
  if (Buffer.byteLength(canonical.content, "utf8") <= MAX_CHECKPOINT_TOOL_RESULT_BYTES) return canonical;
  const contentSha256 = createHash("sha256").update(canonical.content).digest("hex");
  const marker = {
    _kasitek: {
      type: "tool_result_projection",
      truncated: true,
      retrievalHandle: result.id,
      contentSha256,
      originalBytes: Buffer.byteLength(canonical.content, "utf8"),
    },
  };
  let preview = canonical.content.slice(0, 2_000);
  let content = JSON.stringify({ ...marker, preview });
  while (Buffer.byteLength(content, "utf8") > MAX_CHECKPOINT_TOOL_RESULT_BYTES && preview.length > 0) {
    preview = preview.slice(0, Math.floor(preview.length * 0.8));
    content = JSON.stringify({ ...marker, preview });
  }
  return { ...canonical, content };
}

export function assistantToolCallIdempotencyKey(batchId: string): string {
  return `tool-batch:${batchId}:assistant`;
}

export function toolResultIdempotencyKey(batchId: string, runtimeOperationId: string): string {
  return `tool-batch:${batchId}:result:${runtimeOperationId}`;
}

export function toolTranscriptMetadata(input: {
  batchId: string;
  sequenceNumber: number;
  status?: DurableToolCallResult["status"];
  failureClass?: DurableToolCallResult["failureClass"];
  approvalGroupId?: string;
  effectId?: string;
}): Record<string, unknown> {
  return {
    source: "durable_tool_batch",
    batchId: input.batchId,
    sequenceNumber: input.sequenceNumber,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.failureClass === undefined ? {} : { failureClass: input.failureClass }),
    ...(input.approvalGroupId === undefined ? {} : { approvalGroupId: input.approvalGroupId }),
    ...(input.effectId === undefined ? {} : { effectId: input.effectId }),
  };
}
