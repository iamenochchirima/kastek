import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { buildApp } from "./app";
import { connectTemporal, signalRunApproval, signalRunCancellation, startDurableRun } from "../temporal/client";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
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
