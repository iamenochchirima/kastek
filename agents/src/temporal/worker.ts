import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { createActivities } from "./activities";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.TEMPORAL_ENABLED) {
    throw new Error("TEMPORAL_ENABLED must be true when starting the Agent Platform worker");
  }
  const pool = createPool(config);
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
