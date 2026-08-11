import { loadConfig } from "../config";
import { createPool } from "../db/pool";
import { AgentRepository } from "../db/repositories/agent-repository";
import { bootstrapKasiAi } from "./kasiai";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const result = await bootstrapKasiAi(new AgentRepository(pool), config);
    console.log(
      JSON.stringify({
        agentId: result.agent.id,
        slug: result.agent.slug,
        versionId: result.version.id,
        versionNumber: result.version.version_number,
      }),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
