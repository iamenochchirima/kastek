import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";
import { AudioTranscriptionJobRepository } from "../src/db/repositories/audio-transcription-job-repository";
import { ConversationRepository } from "../src/db/repositories/conversation-repository";
import { PlatformChatRepository } from "../src/db/repositories/platform-chat-repository";
import { RunRepository } from "../src/db/repositories/run-repository";
import { loadConfig } from "../src/config";
import { AudioTranscriptionError } from "../src/transcription/provider";
import { AudioTranscriptionWorker } from "../src/transcription/worker";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

function workerConfig() {
  return loadConfig({
    ...process.env,
    NODE_ENV: "test",
    AGENTS_DATABASE_URL: databaseUrl ?? "postgres://audio-transcription.integration",
    AUTH_MODE: "headers",
    TEMPORAL_ENABLED: "false",
    AUDIO_TRANSCRIPTION_MAX_ATTEMPTS: "3",
    AUDIO_TRANSCRIPTION_RETRY_BASE_DELAY_MS: "1",
  });
}

describe.skipIf(!runIntegration)("audio transcription durability (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const agents = new AgentRepository(pool);
  const jobs = new AudioTranscriptionJobRepository(pool);
  const conversations = new ConversationRepository(pool);
  const platformChat = new PlatformChatRepository(pool);
  const runs = new RunRepository(pool);
  const organizationId = `audio-integration-${randomUUID()}`;
  const actorId = `audio-test-user-${randomUUID()}`;
  let agentId = "";
  let versionId = "";
  let installationId = "";

  beforeAll(async () => {
    const agent = await agents.createAgent(organizationId, actorId, { name: "Audio integration agent" });
    agentId = agent.id;
    const version = await agents.createVersion(organizationId, actorId, agent.id, {
      instructions: "Answer briefly.",
      configuration: {},
      policy: {},
    });
    versionId = version.id;
    await agents.publishVersion(organizationId, actorId, agent.id, version.id);
    const installation = await agents.createInstallation(organizationId, actorId, {
      agentVersionId: version.id,
      scopeType: "organization",
      scopeId: organizationId,
      settings: {},
    });
    installationId = installation.id;
  });

  it("deduplicates an audio message, dispatches once, and preserves the text response path", async () => {
    const idempotencyKey = `audio-platform-${randomUUID()}`;
    const content = {
      text: "Please summarize this",
      assetId: `synthetic-audio-${randomUUID()}`,
      mimeType: "audio/ogg",
      mediaKind: "audio",
      transcription: { status: "queued", provider: "elevenlabs" },
    };
    const dispatchInput = {
      idempotencyKey,
      installationId,
      actorId,
      messageType: "attachment",
      content,
      context: { route: "/workspace" },
      createNew: true,
      fileName: "voice-note.ogg",
    };
    const first = await jobs.enqueue({
      organizationId,
      installationId,
      actorId,
      correlationId: randomUUID(),
      idempotencyKey,
      assetId: content.assetId,
      dispatchKind: "platform",
      dispatchInput,
    });
    const duplicate = await jobs.enqueue({
      organizationId,
      installationId,
      actorId,
      correlationId: randomUUID(),
      idempotencyKey,
      assetId: content.assetId,
      dispatchKind: "platform",
      dispatchInput: { ...dispatchInput, content: { ...content, text: "duplicate" } },
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.job.id).toBe(first.job.id);

    const startWorkflow = vi.fn().mockResolvedValue(undefined);
    const worker = new AudioTranscriptionWorker({
      pool,
      config: workerConfig(),
      jobs,
      provider: {
        transcribe: vi.fn().mockResolvedValue({ text: "The voice note summary", languageCode: "en" }),
      },
      coreClient: {
        downloadContentMedia: vi.fn().mockResolvedValue({ bytes: Buffer.from("synthetic audio"), mimeType: "audio/ogg" }),
      } as never,
      platformChat,
      startWorkflow,
      workerId: "audio-integration-worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    const completed = await jobs.get(organizationId, first.job.id);
    expect(completed).toMatchObject({
      status: "completed",
      transcript: "The voice note summary",
      language_code: "en",
      result_run_id: expect.any(String),
      result_message_id: expect.any(String),
      result_conversation_id: expect.any(String),
    });
    expect(startWorkflow).toHaveBeenCalledTimes(1);

    const acceptedRunId = completed?.result_run_id;
    expect(acceptedRunId).toBeTruthy();
    const acceptedRun = await runs.getRun(organizationId, acceptedRunId!);
    expect(acceptedRun?.input).toMatchObject({
      message: expect.objectContaining({ transcript: "The voice note summary", mediaKind: "audio" }),
      context: { route: "/workspace" },
    });

    await runs.transitionRun(acceptedRunId!, "received", "queued");
    await runs.transitionRun(acceptedRunId!, "queued", "running");
    await runs.completeRun(acceptedRunId!, { message: "Here is the summary." });
    const messages = await conversations.listMessages(organizationId, completed!.result_conversation_id!);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "inbound", message_type: "attachment", run_id: acceptedRunId, content: expect.objectContaining({ transcript: "The voice note summary" }) }),
      expect.objectContaining({ direction: "outbound", content: expect.objectContaining({ text: "Here is the summary." }), run_id: acceptedRunId }),
    ]));

    await expect(worker.runOnce()).resolves.toBe(0);
    expect((await pool.query("SELECT count(*)::int AS count FROM agent_runs WHERE organization_id = $1 AND idempotency_key = $2", [organizationId, idempotencyKey])).rows[0]?.count).toBe(1);
  });

  it("retries a transient provider failure without creating duplicate agent work", async () => {
    const idempotencyKey = `audio-retry-${randomUUID()}`;
    const assetId = `synthetic-audio-${randomUUID()}`;
    const enqueued = await jobs.enqueue({
      organizationId,
      installationId,
      actorId,
      correlationId: randomUUID(),
      idempotencyKey,
      assetId,
      dispatchKind: "platform",
      dispatchInput: {
        idempotencyKey,
        installationId,
        actorId,
        messageType: "attachment",
        content: { assetId, mimeType: "audio/ogg", mediaKind: "audio", transcription: { status: "queued", provider: "elevenlabs" } },
        createNew: true,
      },
    });
    const provider = {
      transcribe: vi.fn()
        .mockRejectedValueOnce(new AudioTranscriptionError("provider unavailable", "AUDIO_TRANSCRIPTION_PROVIDER_FAILED", true, 503))
        .mockResolvedValueOnce({ text: "Recovered transcript", languageCode: "en" }),
    };
    const worker = new AudioTranscriptionWorker({
      pool,
      config: workerConfig(),
      jobs,
      provider,
      coreClient: {
        downloadContentMedia: vi.fn().mockResolvedValue({ bytes: Buffer.from("synthetic audio"), mimeType: "audio/ogg" }),
      } as never,
      platformChat,
      startWorkflow: vi.fn().mockResolvedValue(undefined),
      workerId: "audio-integration-worker-2",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(await jobs.get(organizationId, enqueued.job.id)).toMatchObject({ status: "retryable_failed", attempt_count: 1, error_code: "AUDIO_TRANSCRIPTION_PROVIDER_FAILED" });
    await pool.query("UPDATE audio_transcription_jobs SET next_attempt_at = now() WHERE id = $1", [enqueued.job.id]);
    await expect(worker.runOnce()).resolves.toBe(1);
    const completed = await jobs.get(organizationId, enqueued.job.id);
    expect(completed).toMatchObject({ status: "completed", transcript: "Recovered transcript", result_run_id: expect.any(String) });
    expect(provider.transcribe).toHaveBeenCalledTimes(2);
    expect((await pool.query("SELECT count(*)::int AS count FROM agent_runs WHERE organization_id = $1 AND idempotency_key = $2", [organizationId, idempotencyKey])).rows[0]?.count).toBe(1);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM audio_transcription_jobs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM messages WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM participants WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_workflow_state WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_steps WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM conversations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_principals WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    if (versionId) await pool.query("DELETE FROM agent_versions WHERE id = $1", [versionId]);
    if (agentId) await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
