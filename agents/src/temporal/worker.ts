import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { createActivities } from "./activities";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { RunRepository } from "../db/repositories/run-repository";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TEMPORAL_ENABLED) {
    throw new Error("TEMPORAL_ENABLED must be true when starting the Agent Platform worker");
  }
  const pool = createPool(config);
  const effectReceipts = new EffectReceiptRepository(pool);
  const runs = new RunRepository(pool);
  let reconciling = false;
  const reconcileStaleEffects = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      const stale = await effectReceipts.markStaleExecutingUnknown();
      await Promise.all(stale.map((effect) => runs.appendEvent({
        organizationId: effect.organization_id,
        runId: effect.run_id,
        installationId: effect.installation_id,
        eventType: "effect.reconciliation_required",
        payload: { effectId: effect.id, reason: "execution_lease_expired" },
      })));
      if (stale.length) console.warn(`[effect-reconciliation] ${stale.length} provider outcomes require reconciliation`);
    } catch (error) {
      console.error("[effect-reconciliation] stale effect sweep failed", error);
    } finally {
      reconciling = false;
    }
  };
  await reconcileStaleEffects();
  const reconciliationTimer = setInterval(() => void reconcileStaleEffects(), config.EFFECT_RECONCILIATION_INTERVAL_MS);
  const connection = await NativeConnection.connect({
    address: config.TEMPORAL_ADDRESS,
    apiKey: config.TEMPORAL_API_KEY || undefined,
    tls: config.TEMPORAL_MODE === "cloud" ? {} : undefined,
  });
  const worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: require.resolve("./workflows"),
    activities: createActivities(pool, { config }),
    maxConcurrentActivityTaskExecutions: 20,
    maxConcurrentWorkflowTaskExecutions: 100,
  });
  const close = async (): Promise<void> => {
    clearInterval(reconciliationTimer);
    await worker.shutdown();
    await connection.close();
    await pool.end();
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await worker.run();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
