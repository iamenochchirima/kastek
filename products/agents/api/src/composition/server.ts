import { assertKnowledgeBackfilled } from "../capabilities/knowledge/cutover";
import { startSectionBackfill } from "../capabilities/knowledge/backfill-sections";
import { startNativeAnalyticsPublisher } from "../product/reporting/native-analytics";
import { Pool } from "pg";
import { loadPlatformConfig } from "../infrastructure/config";
import { buildPlatformApp } from "./app";
import { createObservationTelemetry, startObservationPublisher } from "../observability/telemetry";
import { createNativeMetrics } from "../observability/metrics";
import { databasePoolOptions } from "../infrastructure/pool-policy";

async function main(): Promise<void> {
  const config = loadPlatformConfig();
  const pool = new Pool({ connectionString: config.AGENTS_DATABASE_URL, ...databasePoolOptions("api"), application_name: "agents-platform",
    connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000 });
  await assertKnowledgeBackfilled(pool);
  const app = await buildPlatformApp({ config, pool });
  const sectionBackfill = startSectionBackfill(pool, app.log);
  const telemetry = startObservationPublisher(pool, createObservationTelemetry("agents-api"));
  const metrics = createNativeMetrics(pool,"api");
  const analytics = startNativeAnalyticsPublisher(pool);
  app.addHook("onClose", async () => { sectionBackfill.stop(); await telemetry.stop(); await analytics.stop(); await metrics?.shutdown(); await pool.end(); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
  try { await app.listen({ host: config.HOST, port: config.PORT }); }
  catch { await app.close(); throw new Error("Agents platform could not start"); }
}
main().catch((error: unknown) => { process.stderr.write(error instanceof Error && error.message.includes("Knowledge backfill") ? `${error.message}\n` : "Agents platform startup failed; check configuration and database access\n"); process.exitCode = 1; });
