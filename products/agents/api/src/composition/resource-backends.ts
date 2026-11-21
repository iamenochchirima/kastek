import type { Pool } from "pg";
import { documentRuntimeFromEnvironment } from "../platform/knowledge";
import { sandboxManagerFromEnvironment } from "../capabilities/sandbox/sandbox";
import { executorRoutes } from "../adapters/executors/executor-client";
import { routedExecutor, type DocumentBackend, type SandboxBackend } from "./routed-resources";

export function resourceBackends(pool: Pool, environment: NodeJS.ProcessEnv = process.env): { sandbox: SandboxBackend | undefined; documents: DocumentBackend | undefined } {
  const routes = executorRoutes(environment);
  if (routes) {
    const resources = routedExecutor(pool, routes, environment.AGENTS_EXECUTOR_DEFAULT_ID || routes[0]!.id);
    return { sandbox: environment.AGENTS_SANDBOX_ENABLED === "1" ? resources.sandbox : undefined, documents: environment.AGENTS_DOCUMENT_RUNTIME_ENABLED === "1" ? resources.documents : undefined };
  }
  return { sandbox: sandboxManagerFromEnvironment(pool, environment), documents: documentRuntimeFromEnvironment(environment) };
}
