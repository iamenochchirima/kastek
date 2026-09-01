import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { NativeConnection, Worker } from "@temporalio/worker";
import { Client } from "@temporalio/client";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { createActivities } from "./activities";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { RunBudgetRepository } from "../db/repositories/run-budget-repository";
import { ApprovalRepository } from "../db/repositories/approval-repository";
import { operationalLogger } from "../telemetry/logger";
import { temporalActivityInterceptors, temporalClientInterceptor } from "../telemetry/temporal";
import { startDurableRun } from "./client";
import { AudioTranscriptionWorker } from "../transcription/worker";
import { ChannelCredentialRepository } from "../db/repositories/channel-credential-repository";
import { ChannelRepository } from "../db/repositories/channel-repository";
import { TelegramBotClient } from "../channels/telegram-client";
import { DiscordBotClient } from "../channels/discord-client";
import { recordBudgetReconciliationRequired } from "../telemetry/spans";
import { MemoryConsolidationWorker } from "../memory/consolidation-worker";
import { runWithRequiredDatabaseContext } from "../db/context";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TEMPORAL_ENABLED) {
    throw new Error("TEMPORAL_ENABLED must be true when starting the Agent Platform worker");
  }
  const pool = createPool(config);
  const effectReceipts = new EffectReceiptRepository(pool);
  const runs = new RunRepository(pool);
  const runBudgets = new RunBudgetRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const connection = await NativeConnection.connect({
    address: config.TEMPORAL_ADDRESS,
    apiKey: config.TEMPORAL_API_KEY || undefined,
    tls: config.TEMPORAL_MODE === "cloud" ? {} : undefined,
  });
  const client = new Client({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    interceptors: { workflow: [temporalClientInterceptor] },
  });
  let reconciling = false;
  const reconcileStaleEffects = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    return runWithRequiredDatabaseContext(
      "temporal-reconciliation",
      { organizationId: "platform", actorId: "system:reconciliation", operator: true },
      async () => {
        try {
          const stale = await effectReceipts.markStaleExecutingUnknown();
          await Promise.all(stale.map((effect) => runs.appendEvent({
            organizationId: effect.organization_id,
            runId: effect.run_id,
            installationId: effect.installation_id,
            eventType: "effect.reconciliation_required",
            payload: { effectId: effect.id, reason: "execution_lease_expired" },
          })));
          const staleModelReservations = await runBudgets.markStaleReservationsUnknown({
            olderThanMs: config.RUN_BUDGET_RECONCILIATION_AGE_MS,
            limit: config.RUN_BUDGET_RECONCILIATION_LIMIT,
            reason: "Model operation lease expired before its provider outcome was recorded",
          });
          await Promise.all(staleModelReservations.map((reservation) => runs.appendEvent({
            organizationId: reservation.organizationId,
            runId: reservation.runId,
            installationId: reservation.installationId,
            eventType: "agent.model.reconciliation_required",
            payload: {
              reservationId: reservation.id,
              reservationKey: reservation.reservationKey,
              reason: "model_operation_lease_expired",
            },
          })));
          recordBudgetReconciliationRequired(staleModelReservations.length);
          const expired = await approvals.expirePending();
          await Promise.all(expired.map(async (approval) => {
            await runs.appendEvent({
              organizationId: approval.organization_id,
              runId: approval.run_id,
              installationId: approval.installation_id,
              eventType: "agent.approval.expired",
              payload: { approvalId: approval.id, providerToolCallId: approval.provider_tool_call_id },
            });
            await effectReceipts.markNotExecuted(approval.organization_id, approval.run_id, approval.provider_tool_call_id, {
              code: "APPROVAL_EXPIRED",
              message: "The approval expired before the effect began",
            });
            try {
              await client.workflow.getHandle(`agent-run-${approval.run_id}`).signal("agent.expire", { reason: "Approval expired" });
            } catch (error) {
              operationalLogger.warn({ err: error, event: "approval.expiry.signal.failed", run_id: approval.run_id }, "Could not signal expired approval");
            }
          }));
          if (stale.length) operationalLogger.warn({ event: "effect.reconciliation.required", count: stale.length }, "Provider outcomes require reconciliation");
          if (staleModelReservations.length) operationalLogger.warn({ event: "model.reconciliation.required", count: staleModelReservations.length }, "Model outcomes require reconciliation");
          if (expired.length) operationalLogger.warn({ event: "approval.expired", count: expired.length }, "Approvals expired");
        } catch (error) {
          operationalLogger.error({ err: error, event: "agent.recovery.sweep.failed" }, "Agent recovery sweep failed");
        } finally {
          reconciling = false;
        }
      },
    );
  };
  await reconcileStaleEffects();
  const reconciliationTimer = setInterval(() => void reconcileStaleEffects(), config.EFFECT_RECONCILIATION_INTERVAL_MS);
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    interceptors: {
      activity: [temporalActivityInterceptors],
      workflowModules: [require.resolve("./workflow-interceptors")],
    },
    activities: createActivities(pool, { config }),
    maxConcurrentActivityTaskExecutions: 20,
    maxConcurrentWorkflowTaskExecutions: 100,
  });
  const audioTranscriptionWorker = new AudioTranscriptionWorker({
    pool,
    config,
    channels: new ChannelRepository(pool),
    channelCredentials: new ChannelCredentialRepository(pool, config.AGENTS_CREDENTIAL_ENCRYPTION_KEY),
    telegramClient: new TelegramBotClient({ apiBaseUrl: config.TELEGRAM_API_BASE_URL, timeoutMs: config.TELEGRAM_API_TIMEOUT_MS }),
    discordClient: new DiscordBotClient({ apiBaseUrl: config.DISCORD_API_BASE_URL, timeoutMs: config.DISCORD_API_TIMEOUT_MS }),
    startWorkflow: async (runId) => {
      const run = await runs.getRunById(runId);
      if (!run) throw new Error("Cannot start workflow for a missing run");
      return startDurableRun(client, config, {
        runId,
        organizationId: run.organization_id,
        actorId: run.created_by,
      });
    },
  });
  const audioTranscriptionLoop = audioTranscriptionWorker.run();
  const memoryConsolidationWorker = config.MEMORY_CONSOLIDATION_ENABLED
    ? new MemoryConsolidationWorker(pool, {
      batchSize: config.MEMORY_CONSOLIDATION_WORKER_BATCH_SIZE,
      leaseMs: config.MEMORY_CONSOLIDATION_WORKER_LEASE_MS,
      pollIntervalMs: config.MEMORY_CONSOLIDATION_WORKER_POLL_INTERVAL_MS,
      maxAttempts: config.MEMORY_CONSOLIDATION_MAX_ATTEMPTS,
      minInboundMessages: config.MEMORY_CONSOLIDATION_MIN_INBOUND_MESSAGES,
    })
    : undefined;
  const memoryConsolidationLoop = memoryConsolidationWorker?.run();
  const close = async (): Promise<void> => {
    clearInterval(reconciliationTimer);
    audioTranscriptionWorker.stop();
    memoryConsolidationWorker?.stop();
    await audioTranscriptionLoop;
    if (memoryConsolidationLoop) await memoryConsolidationLoop;
    await worker.shutdown();
    await connection.close();
    await pool.end();
    await shutdownTelemetry();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await worker.run();
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "agents.worker.startup.failed" }, "Agent worker startup failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
