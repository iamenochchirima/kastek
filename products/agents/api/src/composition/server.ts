import { Pool } from "pg";
import { loadPlatformConfig } from "../infrastructure/config";
import { buildPlatformApp } from "./app";

async function main(): Promise<void> {
  const config = loadPlatformConfig();
  const pool = new Pool({ connectionString: config.AGENTS_DATABASE_URL, max: 10, application_name: "agents-platform",
    connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000 });
  const app = await buildPlatformApp({ config, pool });
  app.addHook("onClose", async () => { await pool.end(); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void app.close(); });
  try { await app.listen({ host: config.HOST, port: config.PORT }); }
  catch { await app.close(); throw new Error("Agents platform could not start"); }
}
main().catch(() => { process.stderr.write("Agents platform startup failed; check configuration and database access\n"); process.exitCode = 1; });
