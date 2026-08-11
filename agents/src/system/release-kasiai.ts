import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { AgentRepository, SYSTEM_ORGANIZATION_ID } from "../db/repositories/agent-repository";
import { KASIAI_RELEASE_ACTOR, KASIAI_SLUG, kasiaiInitialVersion } from "./kasiai";
import { evaluateKasiAiRelease } from "./kasiai-release-gate";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const agents = new AgentRepository(pool);
    const candidate = kasiaiInitialVersion(config);
    const gate = evaluateKasiAiRelease(candidate);
    if (!gate.passed) {
      console.error(JSON.stringify({ error: "kasiai_release_gate_failed", checks: gate.checks }));
      process.exitCode = 1;
      return;
    }
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
    console.log(JSON.stringify({ agentId: agent.id, versionId: version.id, versionNumber: version.version_number, rolledOut, releaseGate: gate.checks }));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
