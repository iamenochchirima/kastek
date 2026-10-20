import { createServer, type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { ConnectedExecutor } from "../src/capabilities/connected-tools/connected-executor";
import { ToolReviewStore } from "../src/capabilities/reviews/tool-reviews";
import { RemoteConnectionStore } from "../src/product/connections/remote-connections";
import { ApiConnectionStore } from "../src/product/connections/api-connections";
import { createNativeApiCapabilityCatalog } from "../src/capabilities/connected-tools/generic-connected-runtime";
import { TaskArtifactStore } from "../src/execution/artifacts/task-artifacts";
import { EvidenceStore } from "../src/execution/context/evidence";
import { privateStoreFromEnvironment } from "../src/infrastructure/object-store";
import { actionsFromEnvironment } from "../src/composition/actions";

async function main() {
  if (process.env.NODE_ENV !== "test") throw Error("Test worker requires NODE_ENV=test");
  const database = process.env.AGENTS_DATABASE_URL, model = process.env.CATALOGUE_MODEL_URL;
  const origin = process.env.AGENTS_PUBLIC_URL, port = Number(process.env.CATALOGUE_WORKER_PORT);
  if (!database || !model || !origin || !port) throw Error("Missing catalogue worker fixture configuration");
  const pool = new Pool({ connectionString: database, max: 8 });
  const objects = privateStoreFromEnvironment(process.env, 10_485_760);
  if (!objects) throw Error("Owned private fixture storage is required");
  const evidence = new EvidenceStore(pool, objects), artifacts = new TaskArtifactStore(pool, objects);
  const actions = actionsFromEnvironment(pool, artifacts);
  if (!actions) throw Error("Owned fixture vault is required");
  const reviews = new ToolReviewStore(pool);
  const remote = new RemoteConnectionStore(pool, actions.connections.vault, { callbackUrl: `${origin}/api/connections/oauth/callback`, testLoopback: true });
  const connected: ConnectedExecutor = new ConnectedExecutor(pool, actions.connections, objects, evidence, {
    resolveRemoteEndpoint: (...args) => remote.resolveRemoteEndpoint(...args),
    ensureCredentialFresh: (...args) => remote.ensureCredentialFresh(...args),
    recordRemoteScopeChallenge: (...args) => remote.recordPermissionChallenge(...args),
    resolveApiOperation: (...args) => api.resolveApiOperation(...args),
    genericReview: reviews.port(), testApiLoopback: true,
  });
  const api: ApiConnectionStore = new ApiConnectionStore(pool, actions.connections.vault, { registry: connected.registry, createCatalog: createNativeApiCapabilityCatalog, testLoopback: true });
  const workflow = createBusinessWorkflow(pool, { connected, evidence, toolReviews: reviews,
    openRouterApiKey: "controlled-model-fixture", fetch: (_url, request) => fetch(model, request) });
  const sessions = new Set<ServerHttp2Session>(), server = createServer(createEndpointHandler({ services: [workflow] }));
  server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  await new Promise<void>(resolve => server.listen(port, "0.0.0.0", resolve));
  process.stdout.write("CATALOGUE_WORKER_READY\n");
  const close = async () => { for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await pool.end(); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close(); });
}
void main().catch(() => { process.stderr.write("Catalogue fixture worker failed\n"); process.exitCode = 1; });
