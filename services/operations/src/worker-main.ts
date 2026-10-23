import "dotenv/config";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { initialize } from "./engine.js";
import { runWorker } from "./worker.js";
const config = loadConfig();
if (
  config.adminSecret ||
  process.env.OPS_OIDC_CLIENT_SECRET ||
  process.env.OPS_SESSION_ENCRYPTION_KEY
)
  throw new Error("Operations worker must not receive human admin credentials");
const pool = createPool(config.databaseUrl),
  controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try {
  await initialize(pool, config);
  await runWorker(pool, config, controller.signal);
} finally {
  await pool.end();
}
