import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { AgentRepository } from "../db/repositories/agent-repository";
import { ExtensionSnapshotRepository } from "../db/repositories/extension-snapshot-repository";
import { synchronizeKasiAi } from "./kasiai";
import { operationalLogger } from "../telemetry/logger";
import { runWithRequiredDatabaseContext } from "../db/context";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const rollout = process.argv.includes("--rollout");
    const synced = await runWithRequiredDatabaseContext(
      "kasiai-release",
      { organizationId: "platform", actorId: "system:kasiai-release", operator: true },
      () => synchronizeKasiAi(new AgentRepository(pool, new ExtensionSnapshotRepository(pool)), config, { rollout }),
    );
    operationalLogger.info({
      event: "kasiai.release.completed",
      agentId: synced.agent.id,
      versionId: synced.version.id,
      versionNumber: synced.version.version_number,
      rolledOut: synced.rolledOut,
      activeInstallations: synced.releaseStatus.activeInstallationCount,
      staleInstallations: synced.releaseStatus.staleInstallationCount,
      rollout,
    }, "KasiAi release completed");
  } finally {
    await pool.end();
    await shutdownTelemetry();
  }
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "kasiai.release.failed" }, "KasiAi release failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
