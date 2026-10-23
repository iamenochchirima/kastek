import "dotenv/config";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { initialize } from "./engine.js";
import { buildApi } from "./api.js";
const config = loadConfig(),
  pool = createPool(config.databaseUrl);
await initialize(pool, config);
const app = await buildApi(pool, config);
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await pool.end();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await app.listen({ host: config.host, port: config.port });
} catch (e) {
  await stop();
  throw e;
}
