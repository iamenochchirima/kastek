import "dotenv/config";
import { initTelemetry } from "@kasitek-labs/server-support/telemetry";

const telemetry = initTelemetry("kasitek-billing-api");
const [{ loadConfig }, { createPool }, { buildApi }] = await Promise.all([
  import("./config.js"),
  import("./db.js"),
  import("./api.js"),
]);
const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApi(pool, config);
let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await pool.end();
  await telemetry.shutdown();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await stop();
  throw error;
}
