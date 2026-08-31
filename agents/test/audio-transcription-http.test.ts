import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { buildApp } from "../src/http/app";
import { hashChannelSecret } from "../src/db/channel-secret-crypto";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  INTERNAL_AUTH_AUDIENCE: "test",
  AUTH_MODE: "headers",
  INTERNAL_AUTH_SECRET: "forward-secret",
  KASITEK_CORE_URL: "https://core.example.test",
  KASITEK_CORE_INTERNAL_TOKEN: "internal-token",
  KASITEK_CORE_TIMEOUT_MS: 10_000,
  LOG_LEVEL: "silent",
};

const fakePool = {
  query: async () => ({ rows: [{ ok: 1 }] }),
} as never;

function audioMultipart(input: {
  bytes?: Buffer;
  mimeType?: string;
  fileName?: string;
} = {}): { payload: Buffer; contentType: string } {
  const boundary = "audio-transcription-http-test";
  const bytes = input.bytes ?? Buffer.from("OggS\u0000test-audio");
  const mimeType = input.mimeType ?? "audio/ogg";
  const fileName = input.fileName ?? "voice.ogg";
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, contentType: `multipart/form-data; boundary=${boundary}` };
}

function authHeaders(input: { organizationId?: string; actorId?: string } = {}): Record<string, string> {
  return {
    "x-organization-id": input.organizationId ?? "org-1",
    "x-actor-id": input.actorId ?? "actor-1",
  };
}

function coreUploadResponse(assetId: string): Response {
  return new Response(JSON.stringify({
    asset: {
      id: assetId,
      kind: "AUDIO",
      mimeType: "audio/ogg",
      fileName: "voice.ogg",
      byteSize: Buffer.from("OggS\u0000test-audio").length,
      processingStatus: "READY",
      scanStatus: "CLEAN",
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function channelConnection(channelType: "telegram" | "discord"): Record<string, unknown> {
  return {
    id: `${channelType}-connection-1`,
    organization_id: "org-1",
    installation_id: "install-1",
    channel_type: channelType,
    channel_key: `${channelType}:channel-1`,
    credential_reference: `${channelType}-credential-1`,
    webhook_secret_hash: hashChannelSecret("webhook-secret"),
    webhook_url: null,
    metadata: {},
    status: "active",
    installation_status: "active",
    created_by: "actor-1",
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
    execution_mode: "kasitek_hosted",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("audio transcription HTTP contracts", () => {
  it("transcribes a validated multipart audio upload and rejects invalid media", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello from audio", languageCode: "en" });
    const app = buildApp({
      config,
      pool: fakePool,
      transcriptionProvider: { transcribe } as never,
    });

    try {
      const upload = audioMultipart();
      const response = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: { ...authHeaders(), "content-type": upload.contentType },
        payload: upload.payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "completed",
        provider: "elevenlabs",
        text: "Hello from audio",
        languageCode: "en",
      });
      expect(transcribe).toHaveBeenCalledWith({
        bytes: Buffer.from("OggS\u0000test-audio"),
        mimeType: "audio/ogg",
        fileName: "voice.ogg",
      });

      const invalid = audioMultipart({ bytes: Buffer.from("not-audio") });
      const invalidResponse = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: { ...authHeaders(), "content-type": invalid.contentType },
        payload: invalid.payload,
      });
      expect(invalidResponse.statusCode).toBe(422);
      expect(invalidResponse.json()).toMatchObject({ error: "AUDIO_INVALID_MEDIA", code: "AUDIO_INVALID_MEDIA" });
      expect(transcribe).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("does not call the provider when the audio feature flag is disabled", async () => {
    const transcribe = vi.fn();
    const app = buildApp({
      config,
      pool: fakePool,
      controls: { isFeatureEnabled: vi.fn().mockResolvedValue(false) } as never,
      transcriptionProvider: { transcribe } as never,
    });

    try {
      const upload = audioMultipart();
      const response = await app.inject({
        method: "POST",
        url: "/v1/audio/transcriptions",
        headers: { ...authHeaders(), "content-type": upload.contentType },
        payload: upload.payload,
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "Audio transcription is disabled", code: "AUDIO_TRANSCRIPTION_DISABLED" });
      expect(transcribe).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("stores platform audio in Core, enqueues durable work, and scopes job status to the organization", async () => {
    const enqueue = vi.fn().mockResolvedValue({
      job: { id: "job-audio-1", status: "queued", asset_id: "asset-audio-1" },
      created: true,
    });
    const job = {
      id: "job-audio-1",
      organization_id: "org-1",
      installation_id: "install-1",
      actor_id: "actor-1",
      correlation_id: "correlation-1",
      idempotency_key: "audio-request-1",
      asset_id: "asset-audio-1",
      dispatch_kind: "platform",
      dispatch_input: {},
      status: "completed",
      attempt_count: 1,
      next_attempt_at: "2026-08-27T00:00:00.000Z",
      lease_owner: null,
      lease_expires_at: null,
      transcript: "Hello from the platform",
      language_code: "en",
      result_conversation_id: "conversation-1",
      result_message_id: "message-1",
      result_run_id: "run-1",
      error_code: null,
      error_message: null,
      started_at: "2026-08-27T00:00:01.000Z",
      completed_at: "2026-08-27T00:00:02.000Z",
      deleted_at: null,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:00:02.000Z",
    };
    const get = vi.fn(async (organizationId: string) => organizationId === "org-1" ? job : null);
    const coreFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      asset: {
        id: "asset-audio-1",
        kind: "AUDIO",
        mimeType: "audio/ogg",
        fileName: "voice.ogg",
        byteSize: Buffer.from("OggS\u0000test-audio").length,
        processingStatus: "READY",
        scanStatus: "CLEAN",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", coreFetch);

    const app = buildApp({
      config,
      pool: fakePool,
      agents: {
        getInstallation: vi.fn().mockResolvedValue({
          id: "install-1",
          organization_id: "org-1",
          status: "active",
          execution_mode: "kasitek_hosted",
          agent_owner_type: "organization",
          agent_protected: false,
          agent_slug: "hosted-agent",
          agent_definition_id: "agent-1",
          agent_version_id: "version-1",
        }),
      } as never,
      controls: { isFeatureEnabled: vi.fn().mockResolvedValue(true) } as never,
      audioTranscriptionJobs: { enqueue, get } as never,
    });

    try {
      const upload = audioMultipart();
      const response = await app.inject({
        method: "POST",
        url: "/v1/installations/install-1/platform/audio",
        headers: {
          ...authHeaders(),
          "content-type": upload.contentType,
          "x-audio-idempotency-key": "audio-request-1",
          "x-audio-conversation-id": "conversation-1",
          "x-audio-caption": "Optional caption",
          "x-audio-context-route": "/workspace",
        },
        payload: upload.payload,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        jobId: "job-audio-1",
        status: "queued",
        assetId: "asset-audio-1",
        created: true,
        durable: true,
      });
      expect(coreFetch).toHaveBeenCalledTimes(1);
      expect(coreFetch.mock.calls[0]?.[0]).toBe("https://core.example.test/api/internal/agents/v1/content/media");
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: "org-1",
        installationId: "install-1",
        actorId: "actor-1",
        idempotencyKey: "audio-request-1",
        assetId: "asset-audio-1",
        dispatchKind: "platform",
        dispatchInput: expect.objectContaining({
          conversationId: "conversation-1",
          content: expect.objectContaining({
            assetId: "asset-audio-1",
            mediaKind: "audio",
            transcription: { status: "queued", provider: "elevenlabs" },
          }),
        }),
      }));

      const statusResponse = await app.inject({
        method: "GET",
        url: "/v1/audio/transcription-jobs/job-audio-1",
        headers: authHeaders(),
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toMatchObject({
        jobId: "job-audio-1",
        status: "completed",
        assetId: "asset-audio-1",
        transcript: "Hello from the platform",
        conversationId: "conversation-1",
        messageId: "message-1",
        runId: "run-1",
      });

      const otherOrganizationResponse = await app.inject({
        method: "GET",
        url: "/v1/audio/transcription-jobs/job-audio-1",
        headers: authHeaders({ organizationId: "org-2" }),
      });
      expect(otherOrganizationResponse.statusCode).toBe(404);
      expect(otherOrganizationResponse.json()).toMatchObject({ error: "AUDIO_TRANSCRIPTION_JOB_NOT_FOUND" });
    } finally {
      await app.close();
    }
  });

  it("queues an authenticated WhatsApp audio inbound envelope without running the agent inline", async () => {
    const enqueue = vi.fn().mockResolvedValue({ job: { id: "job-whatsapp-1", status: "queued" }, created: true });
    const app = buildApp({
      config,
      pool: fakePool,
      channels: { getConnectionForInbound: vi.fn().mockResolvedValue(null) } as never,
      controls: { isFeatureEnabled: vi.fn().mockResolvedValue(true) } as never,
      audioTranscriptionJobs: { enqueue } as never,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/channels/inbound",
        headers: authHeaders(),
        payload: {
          installationId: "00000000-0000-4000-8000-000000000001",
          channelType: "whatsapp",
          channelKey: "whatsapp:+27123456789",
          provider: "whatsapp",
          providerEventId: "wamid-event-1",
          providerMessageId: "wamid-message-1",
          externalIdentity: "+27123456789",
          externalConversationId: "+27123456789",
          messageType: "attachment",
          occurredAt: "2026-08-30T20:24:01.327+00:00",
          content: {
            attachmentId: "provider-media-1",
            assetId: "asset-whatsapp-1",
            mimeType: "audio/ogg",
            mediaKind: "audio",
            text: "Please call me back",
          },
        },
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        jobId: "job-whatsapp-1",
        status: "queued",
        assetId: "asset-whatsapp-1",
        created: true,
        durable: true,
      });
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: "org-1",
        installationId: "00000000-0000-4000-8000-000000000001",
        dispatchKind: "external",
        idempotencyKey: "channel:whatsapp:wamid-event-1",
        dispatchInput: expect.objectContaining({
          provider: "whatsapp",
          providerMessageId: "wamid-message-1",
          content: expect.objectContaining({ assetId: "asset-whatsapp-1", mediaKind: "audio" }),
        }),
      }));
    } finally {
      await app.close();
    }
  });

  it("downloads Telegram voice notes, stores the bytes in Core, and queues transcription", async () => {
    const enqueue = vi.fn().mockResolvedValue({ job: { id: "job-telegram-1", status: "queued" }, created: true });
    const telegramDownload = vi.fn().mockResolvedValue({ bytes: Buffer.from("OggS\u0000telegram"), filePath: "voice/file.ogg" });
    const coreFetch = vi.fn().mockResolvedValue(coreUploadResponse("asset-telegram-1"));
    vi.stubGlobal("fetch", coreFetch);
    const app = buildApp({
      config,
      pool: fakePool,
      channels: { getConnectionForWebhook: vi.fn().mockResolvedValue(channelConnection("telegram")) } as never,
      channelCredentials: { resolve: vi.fn().mockResolvedValue("telegram-token") } as never,
      telegramClient: { downloadFile: telegramDownload, sendMessage: vi.fn() } as never,
      controls: { isFeatureEnabled: vi.fn().mockResolvedValue(true) } as never,
      audioTranscriptionJobs: { enqueue } as never,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/telegram/telegram-connection-1",
        headers: {
          ...authHeaders(),
          "x-kasitek-core-forward-secret": "forward-secret",
          "x-telegram-bot-api-secret-token": "webhook-secret",
        },
        payload: {
          update_id: 13,
          message: {
            message_id: 14,
            date: 1_700_000_000,
            from: { id: 11 },
            chat: { id: 12 },
            caption: "Call me tomorrow",
            voice: { file_id: "voice-1", duration: 4 },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, media: "queued", jobId: "job-telegram-1", created: true });
      expect(telegramDownload).toHaveBeenCalledWith("telegram-token", "voice-1", 25 * 1024 * 1024);
      expect(coreFetch).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/content/media", expect.objectContaining({ method: "POST" }));
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyKey: "channel:telegram:13",
        assetId: "asset-telegram-1",
        dispatchInput: expect.objectContaining({
          externalConversationId: "12",
          content: expect.objectContaining({
            assetId: "asset-telegram-1",
            text: "Call me tomorrow",
            mediaKind: "audio",
            durationMs: 4_000,
            transcription: { status: "queued", provider: "elevenlabs" },
          }),
        }),
      }));
    } finally {
      await app.close();
    }
  });

  it("stores Telegram images sent as files and starts the agent with the asset", async () => {
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0x00]);
    const telegramDownload = vi.fn().mockResolvedValue({ bytes: imageBytes, filePath: "documents/announcement.jpg" });
    const coreFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      asset: {
        id: "asset-telegram-image-1",
        kind: "IMAGE",
        mimeType: "image/jpeg",
        fileName: "announcement.JPG",
        byteSize: imageBytes.length,
        processingStatus: "READY",
        scanStatus: "CLEAN",
      },
    }), { status: 201, headers: { "content-type": "application/json" } }));
    const acceptExternalMessage = vi.fn().mockResolvedValue({
      created: true,
      run: { id: "run-telegram-image-1", status: "received" },
    });
    const startWorkflow = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", coreFetch);
    const app = buildApp({
      config: { ...config, TEMPORAL_ENABLED: true },
      pool: fakePool,
      channels: { getConnectionForWebhook: vi.fn().mockResolvedValue(channelConnection("telegram")) } as never,
      channelCredentials: { resolve: vi.fn().mockResolvedValue("telegram-token") } as never,
      telegramClient: { downloadFile: telegramDownload, sendMessage: vi.fn() } as never,
      platformChat: { acceptExternalMessage } as never,
      startWorkflow,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/telegram/telegram-connection-1",
        headers: {
          ...authHeaders(),
          "x-kasitek-core-forward-secret": "forward-secret",
          "x-telegram-bot-api-secret-token": "webhook-secret",
        },
        payload: {
          update_id: 16,
          message: {
            message_id: 17,
            date: 1_700_000_000,
            from: { id: 11 },
            chat: { id: 12 },
            caption: "Use this artwork",
            document: { file_id: "file-image", file_name: "announcement.JPG", mime_type: "application/octet-stream" },
          },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
      expect(telegramDownload).toHaveBeenCalledWith("telegram-token", "file-image", undefined);
      expect(coreFetch).toHaveBeenCalledWith("https://core.example.test/api/internal/agents/v1/content/media", expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "content-type": "image/jpeg" }),
        body: imageBytes,
      }));
      expect(acceptExternalMessage).toHaveBeenCalledWith(expect.objectContaining({
        messageType: "attachment",
        content: expect.objectContaining({ assetId: "asset-telegram-image-1", mimeType: "image/jpeg", mediaKind: "IMAGE", text: "Use this artwork" }),
      }));
      expect(startWorkflow).toHaveBeenCalledWith("run-telegram-image-1");
    } finally {
      await app.close();
    }
  });

  it("downloads Discord audio attachments, removes the source URL, and queues transcription", async () => {
    const enqueue = vi.fn().mockResolvedValue({ job: { id: "job-discord-1", status: "queued" }, created: true });
    const discordDownload = vi.fn().mockResolvedValue({ bytes: Buffer.from("OggS\u0000discord") });
    const coreFetch = vi.fn().mockResolvedValue(coreUploadResponse("asset-discord-1"));
    vi.stubGlobal("fetch", coreFetch);
    const app = buildApp({
      config,
      pool: fakePool,
      channels: { getConnectionForWebhook: vi.fn().mockResolvedValue(channelConnection("discord")) } as never,
      channelCredentials: { resolve: vi.fn().mockResolvedValue("discord-token") } as never,
      discordClient: { downloadAttachment: discordDownload, sendMessage: vi.fn() } as never,
      controls: { isFeatureEnabled: vi.fn().mockResolvedValue(true) } as never,
      audioTranscriptionJobs: { enqueue } as never,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/webhooks/discord/discord-connection-1",
        headers: { ...authHeaders(), "x-kasitek-core-forward-secret": "forward-secret" },
        payload: {
          id: "discord-event-1",
          channel_id: "channel-1",
          content: "Summarize this",
          author: { id: "user-1" },
          attachments: [{
            id: "attachment-audio-1",
            filename: "voice.webm",
            content_type: "audio/webm",
            duration_secs: 2.5,
            url: "https://cdn.discord.test/temporary-audio",
          }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, media: "queued", jobId: "job-discord-1", created: true });
      expect(discordDownload).toHaveBeenCalledWith("discord-token", "https://cdn.discord.test/temporary-audio", 25 * 1024 * 1024);
      expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyKey: "channel:discord:discord-event-1",
        assetId: "asset-discord-1",
        dispatchInput: expect.objectContaining({
          externalConversationId: "channel-1",
          content: expect.objectContaining({
            assetId: "asset-discord-1",
            mediaKind: "audio",
            text: "Summarize this",
            durationMs: 2_500,
          }),
        }),
      }));
      const enqueueInput = enqueue.mock.calls[0]?.[0] as { dispatchInput: { content: Record<string, unknown> } };
      expect(enqueueInput.dispatchInput.content).not.toHaveProperty("url");
    } finally {
      await app.close();
    }
  });
});
