import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { AppConfig } from "../config";
import { KasitekCoreReadClient, CoreToolError } from "../core/client";
import { PlatformChatRepository } from "../db/repositories/platform-chat-repository";
import {
  AudioTranscriptionJobRepository,
  transcriptionRetryDelayMs,
  type AudioTranscriptionJobRecord,
} from "../db/repositories/audio-transcription-job-repository";
import {
  AudioTranscriptionError,
  type AudioTranscriptionProvider,
} from "./provider";
import { ElevenLabsTranscriptionProvider } from "./elevenlabs";
import { operationalLogger } from "../telemetry/logger";
import { recordQueueAge, recordRetry, withProviderSpan, withSpan } from "../telemetry/spans";
import { ChannelCredentialRepository } from "../db/repositories/channel-credential-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { TelegramBotClient } from "../channels/telegram-client";
import { DiscordBotClient } from "../channels/discord-client";
import { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import { withTransaction } from "../db/pool";
import { enqueueAudioLifecycleEvent, type AudioAnalyticsEventInput } from "../analytics";

type DispatchInput = Record<string, unknown>;
type AudioTranscriptionJobs = Pick<AudioTranscriptionJobRepository, "claimDue" | "markTranscribed" | "markDispatched" | "markRetryable" | "markFailed">;

export interface AudioTranscriptionWorkerOptions {
  pool: Pool;
  config: AppConfig;
  jobs?: AudioTranscriptionJobs;
  provider?: AudioTranscriptionProvider;
  coreClient?: KasitekCoreReadClient;
  platformChat?: PlatformChatRepository;
  channels?: ChannelRepository;
  channelCredentials?: ChannelCredentialRepository;
  telegramClient?: TelegramBotClient;
  discordClient?: DiscordBotClient;
  startWorkflow?: (runId: string) => Promise<void>;
  workerId?: string;
}

function recordValue(input: DispatchInput, key: string): unknown {
  return input[key];
}

function recordString(input: DispatchInput, key: string): string | undefined {
  const value = recordValue(input, key);
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordObject(input: DispatchInput, key: string): Record<string, unknown> {
  const value = recordValue(input, key);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function completedContent(content: Record<string, unknown>, transcript: string, languageCode?: string): Record<string, unknown> {
  const caption = typeof content.text === "string" ? content.text.trim() : "";
  return {
    ...content,
    text: [caption, transcript].filter(Boolean).join("\n\n"),
    transcript,
    transcription: {
      status: "completed",
      provider: "elevenlabs",
      ...(languageCode ? { languageCode } : {}),
    },
  };
}

function errorDetails(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof AudioTranscriptionError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof CoreToolError) {
    return {
      code: error.code,
      message: error.message,
      retryable: !["CORE_NOT_FOUND", "CORE_INVALID_RESPONSE", "CORE_UNAUTHORIZED"].includes(error.code),
    };
  }
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "AUDIO_TRANSCRIPTION_JOB_FAILED";
  const message = error instanceof Error ? error.message : "Audio transcription job failed";
  return {
    code: code.slice(0, 120),
    message: message.slice(0, 2_000),
    retryable: !["channel_identity_not_paired", "conversation_handoff_active", "AUDIO_JOB_INVALID"].includes(code),
  };
}

export class AudioTranscriptionWorker {
  private readonly jobs: AudioTranscriptionJobs;
  private readonly provider: AudioTranscriptionProvider;
  private readonly coreClient: KasitekCoreReadClient;
  private readonly platformChat: PlatformChatRepository;
  private readonly channels: ChannelRepository;
  private readonly channelCredentials: ChannelCredentialRepository;
  private readonly telegramClient: TelegramBotClient;
  private readonly discordClient: DiscordBotClient;
  private readonly workerId: string;
  private stopping = false;

  public constructor(private readonly options: AudioTranscriptionWorkerOptions) {
    this.jobs = options.jobs ?? new AudioTranscriptionJobRepository(options.pool);
    this.provider = options.provider ?? ElevenLabsTranscriptionProvider.fromConfig(options.config);
    this.coreClient = options.coreClient ?? new KasitekCoreReadClient(options.config);
    const controls = new OperatorControlRepository(options.pool);
    this.platformChat = options.platformChat ?? new PlatformChatRepository(options.pool, {
      isHandoffEnabled: (organizationId, installationId) => controls.isFeatureEnabled(organizationId, "customer_handoff_enabled", installationId),
    });
    this.channels = options.channels ?? new ChannelRepository(options.pool);
    this.channelCredentials = options.channelCredentials ?? new ChannelCredentialRepository(options.pool, options.config.AGENTS_CREDENTIAL_ENCRYPTION_KEY);
    this.telegramClient = options.telegramClient ?? new TelegramBotClient({ apiBaseUrl: options.config.TELEGRAM_API_BASE_URL, timeoutMs: options.config.TELEGRAM_API_TIMEOUT_MS });
    this.discordClient = options.discordClient ?? new DiscordBotClient({ apiBaseUrl: options.config.DISCORD_API_BASE_URL, timeoutMs: options.config.DISCORD_API_TIMEOUT_MS });
    this.workerId = options.workerId?.trim() || `audio-transcription-${randomUUID()}`;
  }

  public stop(): void {
    this.stopping = true;
  }

  public async runOnce(): Promise<number> {
    const claimed = await this.jobs.claimDue(
      this.workerId,
      this.options.config.AUDIO_TRANSCRIPTION_WORKER_BATCH_SIZE,
      this.options.config.AUDIO_TRANSCRIPTION_WORKER_LEASE_MS,
    );
    claimed.forEach((job) => recordQueueAge("audio_transcription", Math.max(0, (Date.now() - new Date(job.created_at).getTime()) / 1000)));
    await Promise.all(claimed.map((job) => withSpan(
      "audio.transcription.job",
      { "audio.job.status": job.status, "audio.dispatch.kind": job.dispatch_kind },
      () => this.process(job),
    )));
    return claimed.length;
  }

  public async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.runOnce();
      } catch (error) {
        // A failed poll must not terminate the worker. The next poll will reclaim expired leases.
        operationalLogger.error({ err: error, event: "audio.transcription.poll.failed" }, "Audio transcription worker poll failed");
      }
      if (!this.stopping) await new Promise((resolve) => setTimeout(resolve, this.options.config.AUDIO_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS));
    }
  }

  private async process(job: AudioTranscriptionJobRecord): Promise<void> {
    try {
      const input = job.dispatch_input;
      if (job.status === "processing") {
        await this.recordAnalytics({
          kind: "started",
          jobId: job.id,
          organizationId: job.organization_id,
          dispatchKind: job.dispatch_kind,
          dispatchInput: input,
          attempt: job.attempt_count,
          occurredAt: new Date(),
          createdAt: job.created_at,
        });
        const media = await this.coreClient.downloadContentMedia({
          organizationId: job.organization_id,
          installationId: job.installation_id,
          actorId: job.actor_id,
          runId: job.id,
          correlationId: job.correlation_id,
        }, job.asset_id);
        const transcription = await withProviderSpan("elevenlabs", "speech_to_text", () => this.provider.transcribe({
          bytes: media.bytes,
          mimeType: media.mimeType,
          fileName: recordString(input, "fileName"),
          languageHint: recordString(input, "languageHint"),
        }));
        const claimed = await this.jobs.markTranscribed({
          jobId: job.id,
          workerId: this.workerId,
          transcript: transcription.text,
          languageCode: transcription.languageCode,
        });
        if (!claimed) return;
        await this.recordAnalytics({
          kind: "completed",
          jobId: job.id,
          organizationId: job.organization_id,
          dispatchKind: job.dispatch_kind,
          dispatchInput: input,
          languageCode: transcription.languageCode,
          occurredAt: new Date(),
          createdAt: job.created_at,
        });
        job = {
          ...job,
          status: "dispatching",
          transcript: transcription.text,
          language_code: transcription.languageCode ?? null,
        };
      }

      if (job.status !== "dispatching" || !job.transcript) throw Object.assign(new Error("Audio job has no transcript to dispatch"), { code: "AUDIO_JOB_INVALID" });
      const content = completedContent(recordObject(input, "content"), job.transcript, job.language_code ?? undefined);
      let acceptedRunId: string | null = null;
      let acceptedConversationId: string;
      let acceptedMessageId: string;
      if (job.dispatch_kind === "platform") {
        const accepted = await this.platformChat.acceptMessage({
          organizationId: job.organization_id,
          installationId: job.installation_id,
          actorId: job.actor_id,
          correlationId: job.correlation_id,
          idempotencyKey: recordString(input, "idempotencyKey") ?? job.idempotency_key,
          message: typeof content.text === "string" ? content.text : job.transcript,
          messageType: recordString(input, "messageType") === "attachment" ? "attachment" : "text",
          content,
          context: recordObject(input, "context"),
          conversationId: recordString(input, "conversationId"),
          createNew: recordValue(input, "createNew") === true,
          modelProvider: recordString(input, "modelProvider"),
          model: recordString(input, "model"),
        });
        if (accepted.run?.status === "received" && this.options.startWorkflow) await this.options.startWorkflow(accepted.run.id);
        acceptedRunId = accepted.run?.id ?? null;
        acceptedConversationId = accepted.conversation.id;
        acceptedMessageId = accepted.message.id;
      } else {
        const accepted = await this.platformChat.acceptExternalMessage({
          organizationId: job.organization_id,
          installationId: recordString(input, "installationId") ?? job.installation_id,
          channelType: recordString(input, "channelType") ?? "unknown",
          channelKey: recordString(input, "channelKey"),
          provider: recordString(input, "provider") ?? "unknown",
          providerEventId: recordString(input, "providerEventId") ?? job.idempotency_key,
          providerMessageId: recordString(input, "providerMessageId") ?? job.idempotency_key,
          externalIdentity: recordString(input, "externalIdentity") ?? "unknown",
          externalConversationId: recordString(input, "externalConversationId") ?? "unknown",
          messageType: recordString(input, "messageType") ?? "attachment",
          content,
          occurredAt: recordString(input, "occurredAt"),
          displayName: recordString(input, "displayName"),
          correlationId: job.correlation_id,
        });
        if (accepted.run?.status === "received" && this.options.startWorkflow) await this.options.startWorkflow(accepted.run.id);
        acceptedRunId = accepted.run?.id ?? null;
        acceptedConversationId = accepted.conversation.id;
        acceptedMessageId = accepted.message.id;
      }
      const completed = await this.jobs.markDispatched({
        jobId: job.id,
        workerId: this.workerId,
        conversationId: acceptedConversationId,
        messageId: acceptedMessageId,
        runId: acceptedRunId,
      });
      if (completed) {
        await this.recordAnalytics({
          kind: "dispatched",
          jobId: job.id,
          organizationId: job.organization_id,
          dispatchKind: job.dispatch_kind,
          dispatchInput: input,
          runId: acceptedRunId ?? undefined,
          occurredAt: new Date(),
          createdAt: job.created_at,
        });
        operationalLogger.info({ event: "audio.transcription.dispatched", job_id: job.id, dispatch_kind: job.dispatch_kind, run_id: acceptedRunId }, "Audio transcription dispatched to agent runtime");
      }
    } catch (error) {
      const details = errorDetails(error);
      const exhausted = job.attempt_count >= this.options.config.AUDIO_TRANSCRIPTION_MAX_ATTEMPTS;
      if (details.retryable && !exhausted) {
        recordRetry("audio_transcription", 1);
        await this.jobs.markRetryable({
          jobId: job.id,
          workerId: this.workerId,
          errorCode: details.code,
          errorMessage: details.message,
          delayMs: transcriptionRetryDelayMs(
            job.attempt_count,
            this.options.config.AUDIO_TRANSCRIPTION_RETRY_BASE_DELAY_MS,
            this.options.config.AUDIO_TRANSCRIPTION_RETRY_MAX_DELAY_MS,
          ),
        });
        await this.recordAnalytics({
          kind: "failed",
          jobId: job.id,
          organizationId: job.organization_id,
          dispatchKind: job.dispatch_kind,
          dispatchInput: job.dispatch_input,
          attempt: job.attempt_count,
          errorCode: details.code,
          retryable: true,
          occurredAt: new Date(),
          createdAt: job.created_at,
        });
        operationalLogger.warn({ event: "audio.transcription.retry.scheduled", job_id: job.id, attempt: job.attempt_count, error_code: details.code }, "Audio transcription retry scheduled");
      } else {
        const markedFailed = await this.jobs.markFailed({
          jobId: job.id,
          workerId: this.workerId,
          errorCode: details.code,
          errorMessage: details.message,
        });
        if (markedFailed) {
          await this.recordAnalytics({
            kind: "failed",
            jobId: job.id,
            organizationId: job.organization_id,
            dispatchKind: job.dispatch_kind,
            dispatchInput: job.dispatch_input,
            attempt: job.attempt_count,
            errorCode: details.code,
            retryable: false,
            occurredAt: new Date(),
            createdAt: job.created_at,
          });
          await this.notifyExternalFailure(job);
          operationalLogger.warn({ event: "audio.transcription.failed", job_id: job.id, attempt: job.attempt_count, error_code: details.code, retryable: details.retryable }, "Audio transcription job failed");
        }
      }
    }
  }

  private async recordAnalytics(input: AudioAnalyticsEventInput): Promise<void> {
    try {
      await withTransaction(this.options.pool, (client) => enqueueAudioLifecycleEvent(client, input));
    } catch (error) {
      operationalLogger.warn({ event: "audio.analytics.enqueue.failed", job_id: input.jobId, error_type: error instanceof Error ? error.name : "unknown" }, "Audio lifecycle analytics enqueue failed");
    }
  }

  private async notifyExternalFailure(job: AudioTranscriptionJobRecord): Promise<void> {
    if (job.dispatch_kind !== "external") return;
    const input = job.dispatch_input;
    const channelType = recordString(input, "channelType");
    const channelKey = recordString(input, "channelKey");
    const externalConversationId = recordString(input, "externalConversationId");
    if (!channelType || !externalConversationId) return;
    try {
      const message = "I couldn't transcribe that audio. Please try sending it again.";
      if (channelType === "whatsapp") {
        await this.coreClient.deliverChannelMessage({
          organizationId: job.organization_id,
          installationId: job.installation_id,
          actorId: job.actor_id,
          runId: job.id,
          correlationId: job.correlation_id,
          channelType,
          externalConversationId,
          text: message,
        });
      } else if (channelType === "telegram" || channelType === "discord") {
        if (!channelKey) return;
        const connection = await this.channels.getConnectionForInbound({
          organizationId: job.organization_id,
          channelType,
          channelKey,
        });
        if (!connection?.credential_reference) return;
        if (channelType === "telegram") {
          const token = await this.channelCredentials.resolve(job.organization_id, connection.credential_reference, "telegram");
          await this.telegramClient.sendMessage(token, externalConversationId, message);
        } else {
          const token = await this.channelCredentials.resolve(job.organization_id, connection.credential_reference, "discord");
          await this.discordClient.sendMessage(token, externalConversationId, message);
        }
      } else {
        return;
      }
      operationalLogger.info({ event: "audio.transcription.failure.notified", job_id: job.id, channel: channelType }, "Audio transcription failure notification sent");
    } catch {
      operationalLogger.warn({ event: "audio.transcription.failure.notification.failed", job_id: job.id, channel: channelType }, "Could not send audio transcription failure notification");
    }
  }
}
