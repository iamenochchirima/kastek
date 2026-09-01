import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { AgentRepository, SYSTEM_ORGANIZATION_ID } from "../db/repositories/agent-repository";
import { KASIAI_RELEASE_ACTOR, KASIAI_SLUG, kasiaiInitialVersion } from "./kasiai";
import { evaluateKasiAiRelease } from "./kasiai-release-gate";
import { operationalLogger } from "../telemetry/logger";
import { runWithRequiredDatabaseContext } from "../db/context";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const agents = new AgentRepository(pool);
    const candidate = kasiaiInitialVersion(config);
    const gate = evaluateKasiAiRelease(candidate);
    if (!gate.passed) {
      operationalLogger.error({ event: "kasiai.release.gate.failed", checks: gate.checks }, "KasiAi release gate failed");
      process.exitCode = 1;
      return;
    }
    const { agent, version, rolledOut } = await runWithRequiredDatabaseContext(
      "kasiai-release",
      { organizationId: "platform", actorId: "system:kasiai-release", operator: true },
      async () => {
        const agent = await agents.ensureSystemAgent(KASIAI_RELEASE_ACTOR, {
          organizationId: SYSTEM_ORGANIZATION_ID,
          name: "KasiAi",
          slug: KASIAI_SLUG,
          description: "KasiTek's protected platform guidance agent.",
          protected: true,
        });
        const version = await agents.releaseSystemVersion(KASIAI_RELEASE_ACTOR, agent.id, candidate);
        const rolledOut = process.argv.includes("--rollout")
          ? await agents.rolloutSystemVersion(agent.id, version.id, KASIAI_RELEASE_ACTOR)
          : 0;
        return { agent, version, rolledOut };
      },
    );
    operationalLogger.info({ event: "kasiai.release.completed", agentId: agent.id, versionId: version.id, versionNumber: version.version_number, rolledOut, releaseGate: gate.checks }, "KasiAi release completed");
  } finally {
    await pool.end();
    await shutdownTelemetry();
  }
}

main().catch((error) => {
  operationalLogger.error({ err: error, event: "kasiai.release.failed" }, "KasiAi release failed");
  void shutdownTelemetry().finally(() => { process.exitCode = 1; });
});
