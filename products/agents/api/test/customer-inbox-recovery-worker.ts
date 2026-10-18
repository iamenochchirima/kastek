import { createServer, type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { composeInbox } from "../src/composition/inbox";

async function main() {
  const database = process.env.AGENTS_DATABASE_URL, model = process.env.CHANNEL_RECOVERY_MODEL_URL, origin = process.env.CHANNEL_RECOVERY_ORIGIN;
  const port = Number(process.env.CHANNEL_RECOVERY_PORT);
  if (!database || !model || !origin || !Number.isInteger(port) || port < 1) throw new Error("Missing owned recovery fixture configuration");
  const pool = new Pool({ connectionString: database, max: 6 });
  composeInbox(pool, { publicOrigin: origin, async assertServices(configuration) {
    if (configuration.program.id !== "grounded-conversation" || configuration.tools.length) throw new Error("Recovery fixture supports model-only customer configuration");
  } });
  const workflow = createBusinessWorkflow(pool, { openRouterApiKey: "controlled-local-provider-fixture", fetch: (_url, request) => fetch(model, request) });
  const server = createServer(createEndpointHandler({ services: [workflow] })), sessions = new Set<ServerHttp2Session>();
  server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  await new Promise<void>(resolve => server.listen(port, "0.0.0.0", resolve)); process.stdout.write("CHANNEL_RECOVERY_WORKER_READY\n");
  const close = async () => { for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(); });
}
void main().catch(() => { process.stderr.write("Owned channel recovery worker failed\n"); process.exitCode = 1; });
