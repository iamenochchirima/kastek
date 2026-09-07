import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { AgentRepository } from "../db/repositories/agent-repository";
import { ExtensionSnapshotRepository } from "../db/repositories/extension-snapshot-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { buildApp } from "./app";
import { synchronizeKasiAi } from "../system/kasiai";
import { connectTemporal, signalRunApproval, signalRunCancellation, signalRunExternalEvent, startDurableRun } from "../temporal/client";
import { operationalLogger } from "../telemetry/logger";
import { runWithRequiredDatabaseContext } from "../db/context";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const runs = new RunRepository(pool);
  const releaseContext = config.NODE_ENV === "production"
    ? { operation: "kasiai-production-release", actorId: "system:kasiai-production-release" }
    : { operation: "kasiai-development-sync", actorId: "system:kasiai-development-sync" };
  try {
    const synced = await runWithRequiredDatabaseContext(
      releaseContext.operation,
      { organizationId: "platform", actorId: releaseContext.actorId, operator: true },
      () => synchronizeKasiAi(new AgentRepository(pool, new ExtensionSnapshotRepository(pool)), config),
    );
    operationalLogger.info({
      event: config.NODE_ENV === "production" ? "kasiai.production.release.completed" : "kasiai.synchronized",
      version_number: synced.version.version_number,
      rolled_out: synced.rolledOut,
      active_installations: synced.releaseStatus.activeInstallationCount,
      stale_installations: synced.releaseStatus.staleInstallationCount,
    }, config.NODE_ENV === "production" ? "KasiAi production release gate completed" : "KasiAi synchronized");
  } catch (error) {
    operationalLogger.error({
      err: error,
      event: config.NODE_ENV === "production" ? "kasiai.production.release.failed" : "kasiai.synchronization.failed",
      error_code: (error as { code?: string }).code,
    }, config.NODE_ENV === "production" ? "KasiAi production release gate failed" : "KasiAi synchronization failed");
    await pool.end();
    throw error;
  }
  let temporalConnection: Awaited<ReturnType<typeof connectTemporal>> | undefined;
  if (config.TEMPORAL_ENABLED) temporalConnection = await connectTemporal(config);
  const app = buildApp({
    config,
    pool,
    startWorkflow: temporalConnection
      ? async (runId) => {
        const run = await runs.getRunById(runId);
        if (!run) throw new Error("Cannot start workflow for a missing run");
        return startDurableRun(temporalConnection!.client, config, {
          runId,
          organizationId: run.organization_id,
          actorId: run.created_by,
        });
      }
      : undefined,
    signalApproval: temporalConnection
      ? (runId, signal) => signalRunApproval(temporalConnection!.client, runId, signal)
      : undefined,
    signalCancellation: temporalConnection
      ? (runId, signal) => signalRunCancellation(temporalConnection!.client, runId, signal)
      : undefined,
    signalExternalEvent: temporalConnection
      ? (runId, signal) => signalRunExternalEvent(temporalConnection!.client, runId, signal)
      : undefined,
  });
  const close = async (): Promise<void> => {
    await app.close();
    temporalConnection?.connection.close();
    await pool.end();
    await shutdownTelemetry();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "agents.api.startup.failed" }, "Agent API startup failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
