import { Pool } from "pg";
import { databasePoolOptions } from "../infrastructure/pool-policy";
import { purgeMemoryRevisionContent } from "../execution/memory/retention";
import { expireInactiveConversations } from "../execution/memory/conversation-retention";

export async function runMemoryRetention(pool: Pool, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    let changed = 0;
    try { changed = await purgeMemoryRevisionContent(pool); }
    catch { console.error(JSON.stringify({service:"agents-memory-retention",event:"cleanup.retry",code:"MEMORY_RETENTION_PENDING"})); }
    if (changed) console.info(JSON.stringify({service:"agents-memory-retention",event:"cleanup.completed",revisionBodies:changed}));
    try { await expireInactiveConversations(pool); }
    catch { console.error(JSON.stringify({service:"agents-memory-retention",event:"conversation_expiry.retry",code:"CONVERSATION_RETENTION_PENDING"})); }
    if (!signal.aborted) await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort",done); resolve(); };
      const timer = setTimeout(done,changed ? 1000 : 60_000); signal.addEventListener("abort",done,{once:true});
    });
  }
}
if (require.main === module) {
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const pool = new Pool({connectionString:process.env.AGENTS_DATABASE_URL,...databasePoolOptions("cleanup")});
  const abort = new AbortController(); process.once("SIGINT",()=>abort.abort()); process.once("SIGTERM",()=>abort.abort());
  void runMemoryRetention(pool,abort.signal).catch(()=>{process.exitCode=1;}).finally(()=>pool.end());
}
