import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { buildApp } from "../src/http/app";

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
});
