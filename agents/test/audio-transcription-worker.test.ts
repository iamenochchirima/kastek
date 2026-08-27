import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import type { AudioTranscriptionJobRecord } from "../src/db/repositories/audio-transcription-job-repository";
import { AudioTranscriptionError } from "../src/transcription/provider";
import { AudioTranscriptionWorker } from "../src/transcription/worker";

function config() {
  return loadConfig({
    ...process.env,
    NODE_ENV: "test",
    AGENTS_DATABASE_URL: "postgres://audio-worker.test",
    AUTH_MODE: "headers",
    TEMPORAL_ENABLED: "false",
    AUDIO_TRANSCRIPTION_MAX_ATTEMPTS: "3",
  });
}

function job(overrides: Partial<AudioTranscriptionJobRecord> = {}): AudioTranscriptionJobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    installation_id: "00000000-0000-4000-8000-000000000001",
    actor_id: "actor-1",
    correlation_id: "00000000-0000-4000-8000-000000000002",
    idempotency_key: "audio-event-1",
    asset_id: "asset-1",
    dispatch_kind: "platform",
    dispatch_input: {
      idempotencyKey: "audio-event-1",
      messageType: "attachment",
      content: { text: "caption", assetId: "asset-1", mediaKind: "audio", transcription: { status: "queued", provider: "elevenlabs" } },
      conversationId: "conversation-1",
    },
    status: "processing",
    attempt_count: 1,
    next_attempt_at: "2026-08-27T10:00:00.000Z",
    lease_owner: "worker-1",
    lease_expires_at: "2026-08-27T10:05:00.000Z",
    transcript: null,
    language_code: null,
    result_conversation_id: null,
    result_message_id: null,
    result_run_id: null,
    error_code: null,
    error_message: null,
    started_at: "2026-08-27T10:00:00.000Z",
    completed_at: null,
    deleted_at: null,
    created_at: "2026-08-27T10:00:00.000Z",
    updated_at: "2026-08-27T10:00:00.000Z",
    ...overrides,
  };
}

describe("AudioTranscriptionWorker", () => {
  it("transcribes once, dispatches the existing agent path, and records result ids", async () => {
    const source = job();
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([source]),
      markTranscribed: vi.fn().mockResolvedValue(true),
      markDispatched: vi.fn().mockResolvedValue(true),
      markRetryable: vi.fn(),
      markFailed: vi.fn(),
    };
    const acceptMessage = vi.fn().mockResolvedValue({
      conversation: { id: "conversation-1" },
      message: { id: "message-1" },
      run: { id: "run-1", status: "received" },
    });
    const startWorkflow = vi.fn().mockResolvedValue(undefined);
    const worker = new AudioTranscriptionWorker({
      pool: {} as never,
      config: config(),
      jobs: jobs as never,
      provider: { transcribe: vi.fn().mockResolvedValue({ text: "Hello from the voice note", languageCode: "en" }) },
      coreClient: { downloadContentMedia: vi.fn().mockResolvedValue({ bytes: Buffer.from("audio"), mimeType: "audio/ogg" }) } as never,
      platformChat: { acceptMessage } as never,
      channels: {} as never,
      channelCredentials: {} as never,
      telegramClient: {} as never,
      discordClient: {} as never,
      startWorkflow,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(acceptMessage).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "audio-event-1",
      content: expect.objectContaining({
        text: "caption\n\nHello from the voice note",
        transcript: "Hello from the voice note",
        transcription: { status: "completed", provider: "elevenlabs", languageCode: "en" },
      }),
    }));
    expect(startWorkflow).toHaveBeenCalledWith("run-1");
    expect(jobs.markTranscribed).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job-1", workerId: "worker-1", transcript: "Hello from the voice note", languageCode: "en" }));
    expect(jobs.markDispatched).toHaveBeenCalledWith({ jobId: "job-1", workerId: "worker-1", conversationId: "conversation-1", messageId: "message-1", runId: "run-1" });
    expect(jobs.markRetryable).not.toHaveBeenCalled();
    expect(jobs.markFailed).not.toHaveBeenCalled();
  });

  it("sends a provider-neutral failure message to an external channel after terminal failure", async () => {
    const source = job({
      dispatch_kind: "external",
      dispatch_input: {
        channelType: "telegram",
        channelKey: "telegram-bot-1",
        externalConversationId: "chat-1",
        provider: "telegram",
      },
    });
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([source]),
      markTranscribed: vi.fn(),
      markDispatched: vi.fn(),
      markRetryable: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(true),
    };
    const sendMessage = vi.fn().mockResolvedValue({ status: "sent" });
    const worker = new AudioTranscriptionWorker({
      pool: {} as never,
      config: config(),
      jobs: jobs as never,
      provider: { transcribe: vi.fn().mockRejectedValue(new AudioTranscriptionError("bad audio", "AUDIO_TRANSCRIPTION_INVALID_MEDIA", false, 422)) },
      coreClient: { downloadContentMedia: vi.fn().mockResolvedValue({ bytes: Buffer.from("audio"), mimeType: "audio/ogg" }) } as never,
      platformChat: {} as never,
      channels: { getConnectionForInbound: vi.fn().mockResolvedValue({ credential_reference: "credential-1" }) } as never,
      channelCredentials: { resolve: vi.fn().mockResolvedValue("telegram-token") } as never,
      telegramClient: { sendMessage } as never,
      discordClient: {} as never,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(jobs.markFailed).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "AUDIO_TRANSCRIPTION_INVALID_MEDIA" }));
    expect(sendMessage).toHaveBeenCalledWith("telegram-token", "chat-1", "I couldn't transcribe that audio. Please try sending it again.");
    expect(jobs.markRetryable).not.toHaveBeenCalled();
  });

  it("uses the Core delivery boundary for WhatsApp terminal failures", async () => {
    const source = job({
      dispatch_kind: "external",
      dispatch_input: {
        channelType: "whatsapp",
        externalConversationId: "core-conversation-1",
        provider: "meta-whatsapp",
      },
    });
    const jobs = {
      claimDue: vi.fn().mockResolvedValue([source]),
      markTranscribed: vi.fn(),
      markDispatched: vi.fn(),
      markRetryable: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(true),
    };
    const deliverChannelMessage = vi.fn().mockResolvedValue({ status: "sent" });
    const worker = new AudioTranscriptionWorker({
      pool: {} as never,
      config: config(),
      jobs: jobs as never,
      provider: { transcribe: vi.fn().mockRejectedValue(new AudioTranscriptionError("bad audio", "AUDIO_TRANSCRIPTION_INVALID_MEDIA", false, 422)) },
      coreClient: { downloadContentMedia: vi.fn().mockResolvedValue({ bytes: Buffer.from("audio"), mimeType: "audio/ogg" }), deliverChannelMessage } as never,
      platformChat: {} as never,
      channels: {} as never,
      channelCredentials: {} as never,
      telegramClient: {} as never,
      discordClient: {} as never,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(deliverChannelMessage).toHaveBeenCalledWith({
      organizationId: "org-1",
      installationId: source.installation_id,
      actorId: source.actor_id,
      runId: source.id,
      correlationId: source.correlation_id,
      channelType: "whatsapp",
      externalConversationId: "core-conversation-1",
      text: "I couldn't transcribe that audio. Please try sending it again.",
    });
  });
});
