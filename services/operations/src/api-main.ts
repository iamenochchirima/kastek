import "dotenv/config";
import { initTelemetry } from "@kasitek-labs/server-support/telemetry";
const telemetry = initTelemetry("kasitek-operations-api");
const [{ loadConfig }, { createPool }, { initialize }, { buildApi }] =
  await Promise.all([
    import("./config.js"),
    import("./db.js"),
    import("./engine.js"),
    import("./api.js"),
  ]);
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
  await telemetry.shutdown();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await app.listen({ host: config.host, port: config.port });
} catch (e) {
  await stop();
  throw e;
}
