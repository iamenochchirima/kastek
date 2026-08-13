import { NativeConnection, Worker } from "@temporalio/worker";
import { Client } from "@temporalio/client";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { createActivities } from "./activities";
import { EffectReceiptRepository } from "../db/repositories/effect-receipt-repository";
import { RunRepository } from "../db/repositories/run-repository";
import { ApprovalRepository } from "../db/repositories/approval-repository";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TEMPORAL_ENABLED) {
    throw new Error("TEMPORAL_ENABLED must be true when starting the Agent Platform worker");
  }
  const pool = createPool(config);
  const effectReceipts = new EffectReceiptRepository(pool);
  const runs = new RunRepository(pool);
  const approvals = new ApprovalRepository(pool);
  const connection = await NativeConnection.connect({
    address: config.TEMPORAL_ADDRESS,
    apiKey: config.TEMPORAL_API_KEY || undefined,
    tls: config.TEMPORAL_MODE === "cloud" ? {} : undefined,
  });
  const client = new Client({ connection, namespace: config.TEMPORAL_NAMESPACE });
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
          console.warn(`[approval-expiry] could not signal run ${approval.run_id}`, error);
        }
      }));
      if (stale.length) console.warn(`[effect-reconciliation] ${stale.length} provider outcomes require reconciliation`);
      if (expired.length) console.warn(`[approval-expiry] ${expired.length} approvals expired`);
    } catch (error) {
      console.error("[agent-recovery] sweep failed", error);
    } finally {
      reconciling = false;
    }
  };
  await reconcileStaleEffects();
  const reconciliationTimer = setInterval(() => void reconcileStaleEffects(), config.EFFECT_RECONCILIATION_INTERVAL_MS);
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
