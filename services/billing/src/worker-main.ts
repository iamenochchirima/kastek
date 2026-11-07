import "dotenv/config";
import { initTelemetry } from "@kasitek-labs/server-support/telemetry";

const telemetry = initTelemetry("kasitek-billing-worker");
const [{ loadConfig }, { createPool }, { providerFromConfig }, { runWorker }] =
  await Promise.all([
    import("./config.js"),
    import("./db.js"),
    import("./paystack.js"),
    import("./worker.js"),
  ]);
const config = loadConfig();
if (!config.paystack) throw new Error("Paystack is required for the billing worker");
const pool = createPool(config.databaseUrl);
const controller = new AbortController();
const stop = async () => {
  controller.abort();
  await pool.end();
  await telemetry.shutdown();
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
try {
  await runWorker(pool, config, providerFromConfig(config), controller.signal);
} finally {
  await stop();
}
