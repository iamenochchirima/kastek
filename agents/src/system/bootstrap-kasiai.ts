import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { AgentRepository } from "../db/repositories/agent-repository";
import { bootstrapKasiAi } from "./kasiai";
import { operationalLogger } from "../telemetry/logger";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const result = await bootstrapKasiAi(new AgentRepository(pool), config);
    operationalLogger.info({
        event: "kasiai.bootstrap.completed",
        agentId: result.agent.id,
        slug: result.agent.slug,
        versionId: result.version.id,
        versionNumber: result.version.version_number,
      }, "KasiAi bootstrap completed");
  } finally {
    await pool.end();
    await shutdownTelemetry();
  }
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "kasiai.bootstrap.failed" }, "KasiAi bootstrap failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
