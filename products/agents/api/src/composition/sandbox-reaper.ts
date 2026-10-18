import { databasePoolOptions } from "../infrastructure/pool-policy";
import { Pool } from "pg";
import { sandboxManagerFromEnvironment } from "../capabilities/sandbox/sandbox";

export async function runSandboxReaper(pool: Pool, signal: AbortSignal, intervalMs = 1_000): Promise<void> {
  const manager = sandboxManagerFromEnvironment(pool);
  if (!manager) throw new Error("Sandbox backend is not configured");
  while (!signal.aborted) {
    try { await manager.reap(); }
    catch { console.error(JSON.stringify({ service: "agents-sandbox-reaper", event: "cleanup.retry", code: "SANDBOX_CLEANUP_PENDING" })); }
    await new Promise<void>(done => { const timer=setTimeout(finish,intervalMs);function finish(){clearTimeout(timer);signal.removeEventListener("abort",finish);done();}signal.addEventListener("abort",finish,{once:true}); });
  }
}
if (require.main === module) {
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL,...databasePoolOptions("cleanup")}),abort=new AbortController();
  process.once("SIGINT",()=>abort.abort());process.once("SIGTERM",()=>abort.abort());
  void runSandboxReaper(pool,abort.signal).catch(()=>{console.error(JSON.stringify({service:"agents-sandbox-reaper",event:"startup.failed"}));process.exitCode=1;}).finally(()=>pool.end());
}
