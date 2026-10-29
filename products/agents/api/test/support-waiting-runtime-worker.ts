import { createServer, type ServerHttp2Session } from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { SupportWaitingService } from "../src/product/inbox/support-waiting";
import { createSupportWaitingWorkflow } from "../src/product/inbox/support-waiting-runtime";

async function main() {
  const database = process.env.AGENTS_DATABASE_URL, host = process.env.SUPPORT_WAITING_FIXTURE_HOST, port = Number(process.env.SUPPORT_WAITING_FIXTURE_PORT);
  if (!database || !host || !Number.isInteger(port) || port < 1) throw Error("Missing owned support fixture configuration");
  const pool = new Pool({ connectionString: database, max: 4 });
  const inbox = new InboxStore(pool, {
    async admit() { throw Error("Model admission is unavailable in the support waiting fixture"); },
    async readableOutput() { throw Error("Model output is unavailable in the support waiting fixture"); },
    async cancelRoot() {},
  });
  const service = new SupportWaitingService(pool, (db, input) => inbox.publishWaitingNotice(db, input));
  const advance = service.advance.bind(service);
  service.advance = async taskId => {
    const next = await advance(taskId);
    process.stdout.write(`SUPPORT_WAITING_FIXTURE_STEP ${taskId} ${next?.toISOString() ?? "complete"}\n`);
    if (process.env.SUPPORT_WAITING_FIXTURE_PAUSE_AFTER_COMMIT === "1") {
      process.stdout.write(`SUPPORT_WAITING_FIXTURE_COMMITTED ${taskId}\n`);
      await new Promise<void>(() => {});
    }
    return next;
  };
  const server = createServer(createEndpointHandler({ services: [createSupportWaitingWorkflow(service)] })), sessions = new Set<ServerHttp2Session>();
  server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  await new Promise<void>(resolve => server.listen(port, host, resolve));
  process.stdout.write("SUPPORT_WAITING_FIXTURE_READY\n");
  const close = async () => { for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(); });
}
void main().catch(() => { process.stderr.write("Owned support waiting fixture failed\n"); process.exitCode = 1; });
