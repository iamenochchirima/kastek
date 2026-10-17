import { createServer, type ServerHttp2Session } from "node:http2";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { createBusinessWorkflow } from "./business";
import { startDispatcher } from "./dispatcher";
import { WORKFLOW_NAME } from "./execution";
import { workerSecurityFromEnvironment } from "./worker-security";

async function main(): Promise<void> {
  const diagnosticIdentity = { service: "agents-worker", environment: process.env.NODE_ENV || "development",
    release: (process.env.KASITEK_RELEASE_ID || "development").slice(0, 128) };
  if (!process.env.AGENTS_DATABASE_URL) throw new Error("AGENTS_DATABASE_URL is required");
  const port = Number(process.env.RESTATE_WORKER_PORT ?? 9080);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid RESTATE_WORKER_PORT");
  const pool = new Pool({ connectionString: process.env.AGENTS_DATABASE_URL, max: 10,
    connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000 });
  const abort = new AbortController();
  const workflow = createBusinessWorkflow(pool, { openRouterApiKey: process.env.OPENROUTER_API_KEY, signal: abort.signal });
  const {host,identityKeys} = workerSecurityFromEnvironment();
  const server = createServer(createEndpointHandler({ services: [workflow], identityKeys }));
  const sessions = new Set<ServerHttp2Session>();
  server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  try {
    await pool.query("SELECT 1 FROM agents_platform.tasks LIMIT 1");
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  } catch (error) { server.close(); await pool.end(); throw error; }
  const dispatcher = startDispatcher(pool, {
    ingressUrl: process.env.RESTATE_INGRESS_URL ?? "http://127.0.0.1:18080",
    adminUrl: process.env.RESTATE_ADMIN_URL ?? "http://127.0.0.1:19070",
    onError: code => console.error(JSON.stringify({ ...diagnosticIdentity, event: "runtime_publisher_error", code })),
  });
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    abort.abort();
    await dispatcher.stop();
    await new Promise<void>(resolve => {
      const deadline = setTimeout(() => { for (const session of sessions) session.destroy(); }, 10_000);
      server.close(() => { clearTimeout(deadline); resolve(); });
      for (const session of sessions) session.close();
    });
    await pool.end();
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  console.log(JSON.stringify({ ...diagnosticIdentity, event: "ready", port, workflow: WORKFLOW_NAME }));
}

if (require.main === module) void main().catch(() => {
  console.error(JSON.stringify({ service: "agents-worker", event: "startup_failed" }));
  process.exitCode = 1;
});
