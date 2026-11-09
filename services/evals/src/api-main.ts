import "dotenv/config";
import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { migrate } from "./migrate.js";

const config = loadConfig();
await migrate(config.databaseUrl);
const pool = createPool(config.databaseUrl);
const app = buildApi(pool, config);

let closing = false;
async function stop(): Promise<void> {
  if (closing) return;
  closing = true;
  await app.close();
  await pool.end();
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
} catch (error) {
  await stop();
  throw error;
}
