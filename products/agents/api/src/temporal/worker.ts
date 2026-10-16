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
import { recordApprovalGroupLifecycle, recordBudgetReconciliationRequired } from "../telemetry/spans";
import { MemoryRevisionConsolidationWorker } from "../memory/revision-consolidation-worker";
import { MemoryDeletionWorker } from "../memory/deletion-worker";
import { MemoryRetentionWorker } from "../memory/retention-worker";
import { MemoryProjectionWorker } from "../memory/projection-worker";
import { MemoryProviderDeletionWorker } from "../memory/provider-deletion-worker";
import { OperatorControlRepository } from "../db/repositories/operator-control-repository";
import { runWithRequiredDatabaseContext } from "../db/context";
import { AgentRepository } from "../db/repositories/agent-repository";
import { ExtensionSnapshotRepository } from "../db/repositories/extension-snapshot-repository";
import { assertKasiAiReleaseCurrent } from "../system/kasiai";
import { createChildWorkflowActivities } from "../children/temporal-activities";
import { createTemporalChildWorkflowAdapter, TemporalChildInvocationCoordinator } from "../children/temporal-coordinator";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TEMPORAL_ENABLED) {
    throw new Error("TEMPORAL_ENABLED must be true when starting the Agent Platform worker");
  }
  const pool = createPool(config);
  if (config.NODE_ENV === "production") {
    try {
      const releaseStatus = await runWithRequiredDatabaseContext(
        "kasiai-worker-release-check",
        { organizationId: "platform", actorId: "system:kasiai-worker-release-check", operator: true },
        () => assertKasiAiReleaseCurrent(new AgentRepository(pool, new ExtensionSnapshotRepository(pool)), config),
      );
      operationalLogger.info({
        event: "kasiai.worker.release.check.completed",
        version_number: releaseStatus.publishedVersionNumber,
        active_installations: releaseStatus.activeInstallationCount,
      }, "KasiAi worker release check completed");
    } catch (error) {
      operationalLogger.error({
        err: error,
        event: "kasiai.worker.release.check.failed",
        error_code: (error as { code?: string }).code,
      }, "KasiAi worker release check failed");
      await pool.end();
      throw error;
    }
  }
  const effectReceipts = new EffectReceiptRepository(pool);
  const runs = new RunRepository(pool);
  const operatorControls = new OperatorControlRepository(pool);
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
  const childInvocationCoordinator = new TemporalChildInvocationCoordinator(
    createTemporalChildWorkflowAdapter(client),
    {
      workflowType: "agentChildWorkflow",
      taskQueue: config.TEMPORAL_TASK_QUEUE,
    },
  );
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
          const expiredGroups = await approvals.expireGroups();
          await Promise.all(expiredGroups.map(async (group) => {
            const operations = await approvals.listGroupOperations(group.organization_id, group.id);
            const createdAt = Date.parse(group.created_at);
            const decidedAt = group.decided_at ? Date.parse(group.decided_at) : Number.NaN;
            const durationMs = Number.isFinite(createdAt) && Number.isFinite(decidedAt) && decidedAt >= createdAt
              ? decidedAt - createdAt
              : undefined;
            await runs.appendEvent({
              organizationId: group.organization_id,
              runId: group.run_id,
              installationId: group.installation_id,
              eventType: "agent.approval.group.expired",
              payload: {
                approvalGroupId: group.id,
                runId: group.run_id,
                batchId: group.batch_id,
                planDigest: group.plan_digest,
                policyRevision: group.policy_revision,
                operationCount: operations.length,
                selectedCount: 0,
                actor: "system",
                errorCode: "APPROVAL_EXPIRED",
                operationIds: operations.map((operation) => operation.runtime_operation_id),
                expiresAt: group.expires_at,
                ...(durationMs !== undefined ? { durationMs } : {}),
              },
            });
            recordApprovalGroupLifecycle({ action: "expired", operationCount: operations.length, selectedCount: 0, errorCode: "APPROVAL_EXPIRED" });
            await Promise.all(operations.map((approval) => effectReceipts.markNotExecuted(group.organization_id, group.run_id, approval.provider_tool_call_id, {
              code: "APPROVAL_EXPIRED",
              message: "The approval group expired before the effect began",
            }, approval.runtime_operation_id)));
            try {
              await client.workflow.getHandle(`agent-run-${group.run_id}`).signal("agent.expire", { reason: "Approval group expired" });
            } catch (error) {
              operationalLogger.warn({ err: error, event: "approval.group.expiry.signal.failed", run_id: group.run_id, approval_group_id: group.id }, "Could not signal expired approval group");
            }
          }));
          if (stale.length) operationalLogger.warn({ event: "effect.reconciliation.required", count: stale.length }, "Provider outcomes require reconciliation");
          if (staleModelReservations.length) operationalLogger.warn({ event: "model.reconciliation.required", count: staleModelReservations.length }, "Model outcomes require reconciliation");
          if (expiredGroups.length) operationalLogger.warn({ event: "approval.group.expired", count: expiredGroups.length }, "Approval groups expired");
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
    activities: {
      ...createActivities(pool, { config, childInvocationCoordinator }),
      ...createChildWorkflowActivities(pool),
    },
    maxConcurrentActivityTaskExecutions: 20,
    maxConcurrentWorkflowTaskExecutions: 100,
    // Long-running model/tool Activities heartbeat for cancellation and
    // recovery. Bound SDK heartbeat throttling so an application cancellation
    // reaches a provider-backed Activity promptly instead of waiting for the
    // worker's default throttle window.
    maxHeartbeatThrottleInterval: "5 seconds",
    defaultHeartbeatThrottleInterval: "5 seconds",
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
  const memoryConsolidationWorker = config.MEMORY_V2_ENABLED && config.MEMORY_CONSOLIDATION_ENABLED
    ? new MemoryRevisionConsolidationWorker(pool, {
      batchSize: config.MEMORY_CONSOLIDATION_WORKER_BATCH_SIZE,
      leaseMs: config.MEMORY_CONSOLIDATION_WORKER_LEASE_MS,
      pollIntervalMs: config.MEMORY_CONSOLIDATION_WORKER_POLL_INTERVAL_MS,
      maxAttempts: config.MEMORY_CONSOLIDATION_MAX_ATTEMPTS,
      minInboundMessages: config.MEMORY_CONSOLIDATION_MIN_INBOUND_MESSAGES,
      extractionTimeoutMs: config.MEMORY_CONSOLIDATION_EXTRACTOR_TIMEOUT_MS,
    }, {
      controls: operatorControls,
    })
    : undefined;
  const memoryConsolidationLoop = memoryConsolidationWorker?.run();
  const memoryProjectionWorker = config.MEMORY_V2_ENABLED && config.MEMORY_PROJECTION_ENABLED
    ? new MemoryProjectionWorker(pool, {
      batchSize: config.MEMORY_PROJECTION_WORKER_BATCH_SIZE,
      leaseMs: config.MEMORY_PROJECTION_WORKER_LEASE_MS,
      pollIntervalMs: config.MEMORY_PROJECTION_WORKER_POLL_INTERVAL_MS,
      retryBaseDelayMs: config.MEMORY_PROJECTION_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: config.MEMORY_PROJECTION_RETRY_MAX_DELAY_MS,
    }, {
      analyticsPool: pool,
      controls: operatorControls,
    })
    : undefined;
  const memoryProjectionLoop = memoryProjectionWorker?.run();
  const memoryProviderDeletionWorker = config.MEMORY_V2_ENABLED && config.MEMORY_PROVIDER_DELETION_ENABLED
    ? new MemoryProviderDeletionWorker(pool, {
      batchSize: config.MEMORY_PROVIDER_DELETION_WORKER_BATCH_SIZE,
      leaseMs: config.MEMORY_PROVIDER_DELETION_WORKER_LEASE_MS,
      pollIntervalMs: config.MEMORY_PROVIDER_DELETION_WORKER_POLL_INTERVAL_MS,
      maxAttempts: config.MEMORY_PROVIDER_DELETION_MAX_ATTEMPTS,
      retryBaseDelayMs: config.MEMORY_PROVIDER_DELETION_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: config.MEMORY_PROVIDER_DELETION_RETRY_MAX_DELAY_MS,
    }, {
      analyticsPool: pool,
    })
    : undefined;
  const memoryProviderDeletionLoop = memoryProviderDeletionWorker?.run();
  const memoryDeletionWorker = config.MEMORY_V2_ENABLED && config.MEMORY_DELETION_ENABLED
    ? new MemoryDeletionWorker(pool, {
      batchSize: config.MEMORY_DELETION_WORKER_BATCH_SIZE,
      leaseMs: config.MEMORY_DELETION_WORKER_LEASE_MS,
      pollIntervalMs: config.MEMORY_DELETION_WORKER_POLL_INTERVAL_MS,
      maxAttempts: config.MEMORY_DELETION_MAX_ATTEMPTS,
      retryBaseDelayMs: config.MEMORY_DELETION_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: config.MEMORY_DELETION_RETRY_MAX_DELAY_MS,
      holdRetryMs: config.MEMORY_DELETION_HOLD_RETRY_MS,
    }, {
      analyticsPool: pool,
    })
    : undefined;
  const memoryDeletionLoop = memoryDeletionWorker?.run();
  const memoryRetentionWorker = config.MEMORY_V2_ENABLED && config.MEMORY_RETENTION_ENABLED
    ? new MemoryRetentionWorker(pool, {
      batchSize: config.MEMORY_RETENTION_WORKER_BATCH_SIZE,
      leaseMs: config.MEMORY_RETENTION_WORKER_LEASE_MS,
      pollIntervalMs: config.MEMORY_RETENTION_WORKER_POLL_INTERVAL_MS,
      maxAttempts: config.MEMORY_RETENTION_MAX_ATTEMPTS,
      retryBaseDelayMs: config.MEMORY_RETENTION_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: config.MEMORY_RETENTION_RETRY_MAX_DELAY_MS,
      retentionIntervalMs: config.MEMORY_RETENTION_INTERVAL_MS,
      revalidationIntervalMs: config.MEMORY_REVALIDATION_INTERVAL_MS,
      conflictIntervalMs: config.MEMORY_CONFLICT_INTERVAL_MS,
      candidateBatchSize: config.MEMORY_RETENTION_CANDIDATE_BATCH_SIZE,
    })
    : undefined;
  const memoryRetentionLoop = memoryRetentionWorker?.run();
  const close = async (): Promise<void> => {
    clearInterval(reconciliationTimer);
    audioTranscriptionWorker.stop();
    // Every memory worker owns leased work. Stop polling and wait for each
    // worker through its bounded shutdown contract before closing the shared
    // database connection. A timeout leaves the lease for successor recovery;
    // awaiting the loop itself here would make SIGTERM hang behind a provider
    // that never returns.
    const shutdownTimeoutMs = config.MEMORY_CONSOLIDATION_SHUTDOWN_TIMEOUT_MS;
    const memoryShutdowns = Promise.all([
      memoryConsolidationWorker
        ? memoryConsolidationWorker.shutdown(shutdownTimeoutMs)
        : Promise.resolve({ drained: true, abandoned: 0 }),
      memoryProjectionWorker
        ? memoryProjectionWorker.shutdown(shutdownTimeoutMs)
        : Promise.resolve({ drained: true }),
      memoryProviderDeletionWorker
        ? memoryProviderDeletionWorker.shutdown(shutdownTimeoutMs)
        : Promise.resolve({ drained: true }),
      memoryDeletionWorker
        ? memoryDeletionWorker.shutdown(shutdownTimeoutMs)
        : Promise.resolve({ drained: true }),
      memoryRetentionWorker
        ? memoryRetentionWorker.shutdown(shutdownTimeoutMs)
        : Promise.resolve({ drained: true }),
    ]);
    await audioTranscriptionLoop;
    const [consolidationShutdown, projectionShutdown, providerDeletionShutdown, deletionShutdown, retentionShutdown] = await memoryShutdowns;
    if (!consolidationShutdown.drained) {
      operationalLogger.warn({
        event: "memory.revision.consolidation.shutdown.abandoned",
        abandoned: consolidationShutdown.abandoned,
      }, "Memory consolidation shutdown deadline reached; leases were requeued");
    }
    const boundedShutdowns = [
      ["memory.projection", projectionShutdown.drained],
      ["memory.provider-deletion", providerDeletionShutdown.drained],
      ["memory.deletion", deletionShutdown.drained],
      ["memory.retention", retentionShutdown.drained],
    ] as const;
    for (const [workerName, drained] of boundedShutdowns) {
      if (!drained) {
        operationalLogger.warn({
          event: `${workerName}.shutdown.abandoned`,
          worker: workerName,
        }, "Memory worker shutdown deadline reached; leased work remains recoverable");
      }
    }
    if (memoryConsolidationLoop && consolidationShutdown.drained) await memoryConsolidationLoop;
    if (memoryProjectionLoop && projectionShutdown.drained) await memoryProjectionLoop;
    if (memoryProviderDeletionLoop && providerDeletionShutdown.drained) await memoryProviderDeletionLoop;
    if (memoryDeletionLoop && deletionShutdown.drained) await memoryDeletionLoop;
    if (memoryRetentionLoop && retentionShutdown.drained) await memoryRetentionLoop;
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
