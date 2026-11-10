import "dotenv/config";
import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";
import { restoreReadySandboxRuntimes } from "./runtime.js";

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const app = buildApi(pool, config);

let closing = false;
let restoring = false;
let restoreTimer: NodeJS.Timeout | undefined;
async function stop(): Promise<void> {
  if (closing) return;
  closing = true;
  if (restoreTimer) clearInterval(restoreTimer);
  await app.close();
  await pool.end();
}

async function restoreRuntimes(): Promise<void> {
  if (closing || restoring) return;
  restoring = true;
  try {
    const failures = await restoreReadySandboxRuntimes(config, pool);
    if (failures.length) {
      app.log.warn(
        { event: "sandbox.runtime.restore_failed", failures },
        "Some sandbox runtimes could not be restored",
      );
    }
  } catch (error) {
    app.log.error(
      { event: "sandbox.runtime.restore_failed" },
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    restoring = false;
  }
}

process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      event: "service.started",
      host: config.host,
      port: config.port,
      environment: config.environment,
      sandboxDatabase: config.evalDatabase.database,
    },
    "Evaluation service started",
  );
  void restoreRuntimes();
  restoreTimer = setInterval(() => void restoreRuntimes(), 10_000);
  restoreTimer.unref();
} catch (error) {
  await stop();
  throw error;
}
