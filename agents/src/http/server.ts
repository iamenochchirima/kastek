import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { AgentRepository } from "../db/repositories/agent-repository";
import { buildApp } from "./app";
import { synchronizeKasiAi } from "../system/kasiai";
import { connectTemporal, signalRunApproval, signalRunCancellation, signalRunExternalEvent, startDurableRun } from "../temporal/client";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  if (config.NODE_ENV !== "production") {
    const synced = await synchronizeKasiAi(new AgentRepository(pool), config);
    console.log(`[kasiai] synchronized version ${synced.version.version_number}; rolled out ${synced.rolledOut} installation(s)`);
  }
  let temporalConnection: Awaited<ReturnType<typeof connectTemporal>> | undefined;
  if (config.TEMPORAL_ENABLED) temporalConnection = await connectTemporal(config);
  const app = buildApp({
    config,
    pool,
    startWorkflow: temporalConnection
      ? (runId) => startDurableRun(temporalConnection!.client, config, { runId })
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
  };
  process.once("SIGINT", () => void close().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void close().finally(() => process.exit(0)));
  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
