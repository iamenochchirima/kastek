import type { PoolClient } from "pg";
import { buildEvent, type AnalyticsOutboxRecord } from "./producer";
import { enqueueOutbox } from "./producer";

export type AudioAnalyticsEventKind = "received" | "started" | "completed" | "failed" | "dispatched" | "retry";
export type AudioAnalyticsChannel = "whatsapp" | "telegram" | "discord" | "platform" | "website";

export interface AudioAnalyticsEventInput {
  kind: AudioAnalyticsEventKind;
  jobId: string;
  organizationId: string;
  dispatchKind: "platform" | "external";
  dispatchInput: Record<string, unknown>;
  occurredAt?: Date | string;
  attempt?: number;
  runId?: string;
  languageCode?: string | null;
  retryReason?: "user" | "operator";
  errorCode?: string;
  retryable?: boolean;
  createdAt?: Date | string;
}

const AUDIO_MIME_TYPES = new Set([
  "audio/aac",
  "audio/flac",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "application/ogg",
]);

function stringValue(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function content(input: AudioAnalyticsEventInput): Record<string, unknown> {
  const value = input.dispatchInput.content;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function channel(input: AudioAnalyticsEventInput): AudioAnalyticsChannel {
  const value = stringValue(input.dispatchInput, "channelType");
  if (value === "whatsapp" || value === "telegram" || value === "discord" || value === "website") return value;
  return input.dispatchKind === "platform" ? "platform" : "website";
}

function mimeType(input: AudioAnalyticsEventInput): string {
  const value = stringValue(content(input), "mimeType")?.toLowerCase();
  return value && AUDIO_MIME_TYPES.has(value) ? value : "application/ogg";
}

function durationMs(input: AudioAnalyticsEventInput): number | null {
  const value = content(input).durationMs ?? content(input).duration_ms;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function durationBucket(input: AudioAnalyticsEventInput): string {
  const value = durationMs(input);
  if (value === null) return "unknown";
  if (value < 5_000) return "0_5s";
  if (value < 30_000) return "5_30s";
  if (value < 60_000) return "30_60s";
  if (value <= 180_000) return "60_180s";
  return "over_180s";
}

function latencyBucket(input: AudioAnalyticsEventInput): string {
  if (!input.createdAt || !input.occurredAt) return "over_60s";
  const latencyMs = new Date(input.occurredAt).getTime() - new Date(input.createdAt).getTime();
  if (!Number.isFinite(latencyMs) || latencyMs < 1_000) return "under_1s";
  if (latencyMs < 5_000) return "1_5s";
  if (latencyMs < 15_000) return "5_15s";
  if (latencyMs < 60_000) return "15_60s";
  return "over_60s";
}

function boundedAttempt(value: number | undefined): number {
  return Math.min(20, Math.max(1, Number.isSafeInteger(value) ? value! : 1));
}

function safeErrorCode(value: string | undefined): string {
  const normalized = (value ?? "AUDIO_TRANSCRIPTION_JOB_FAILED").toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 80);
  return normalized || "AUDIO_TRANSCRIPTION_JOB_FAILED";
}

export function buildAudioLifecycleEvent(input: AudioAnalyticsEventInput): AnalyticsOutboxRecord {
  const occurredAt = input.occurredAt ?? new Date();
  const currentChannel = channel(input);
  const attempt = boundedAttempt(input.attempt);
  const attributes: Record<string, unknown> = {
    job_id: input.jobId,
    occurred_at: new Date(occurredAt).toISOString(),
  };
  let contractName: string;
  let recordSuffix: string;

  switch (input.kind) {
    case "received":
      contractName = "agent.audio_message.received@1";
      recordSuffix = "received";
      Object.assign(attributes, {
        channel: currentChannel,
        mime_type: mimeType(input),
        duration_bucket: durationBucket(input),
      });
      break;
    case "started":
      contractName = "agent.audio_transcription.started@1";
      recordSuffix = `started:${attempt}`;
      Object.assign(attributes, { provider: "elevenlabs", attempt });
      break;
    case "completed":
      contractName = "agent.audio_transcription.completed@1";
      recordSuffix = "completed";
      Object.assign(attributes, {
        provider: "elevenlabs",
        channel: currentChannel,
        duration_bucket: durationBucket(input),
        latency_bucket: latencyBucket(input),
        ...(input.languageCode?.trim() ? { language: input.languageCode.trim().slice(0, 8) } : {}),
      });
      break;
    case "failed":
      contractName = "agent.audio_transcription.failed@1";
      recordSuffix = `failed:${attempt}`;
      Object.assign(attributes, {
        provider: "elevenlabs",
        channel: currentChannel,
        error_code: safeErrorCode(input.errorCode),
        retryable: input.retryable === true,
        attempt,
      });
      break;
    case "dispatched":
      if (!input.runId?.trim()) throw new Error("Audio dispatch analytics requires a run id");
      contractName = "agent.audio_agent.dispatched@1";
      recordSuffix = "dispatched";
      Object.assign(attributes, { channel: currentChannel, run_id: input.runId });
      break;
    case "retry":
      contractName = "agent.audio_user.retry@1";
      recordSuffix = `retry:${input.retryReason ?? "operator"}:${attempt}`;
      Object.assign(attributes, { channel: currentChannel, reason: input.retryReason ?? "operator", attempt });
      break;
  }

  return buildEvent({
    recordId: `audio:${input.jobId}:${recordSuffix}`,
    sourceDomain: "agents",
    sourceStreamKey: `organization:${input.organizationId}:audio-transcription`,
    contractName,
    schemaVersion: 1,
    scopeKind: "core_organization",
    scopeExternalId: input.organizationId,
    subject: `audio-job:${input.jobId}`,
    occurredAt,
    attributes,
    idempotencyKey: `agent-platform:audio:${input.jobId}:${recordSuffix}`,
  });
}

export async function enqueueAudioLifecycleEvent(client: PoolClient, input: AudioAnalyticsEventInput): Promise<void> {
  await enqueueOutbox(client, buildAudioLifecycleEvent(input));
}
