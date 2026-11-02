import { Pool } from "pg";
import { controlGrowthExecution, growthControlInputSchema } from "../product/integrations/growth-control";
import { databasePoolOptions } from "../infrastructure/pool-policy";

async function main(): Promise<void> {
  const input = growthControlInputSchema.parse({
    tenantId: process.env.GROWTH_CONTROL_TENANT_ID,
    action: process.env.GROWTH_CONTROL_ACTION,
  });
  if (!process.env.AGENTS_DATABASE_URL) throw Error("Agent database is not configured");
  const pool = new Pool({
    connectionString: process.env.AGENTS_DATABASE_URL,
    ...databasePoolOptions("migration"),
  });
  try {
    const result = await controlGrowthExecution(pool, input);
    process.stdout.write(JSON.stringify({ event: "growth_execution_controlled", ...result }) + "\n");
    if (result.pendingTaskTrees) process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

if (require.main === module) void main().catch(() => {
  process.stderr.write("Growth execution control failed; check the explicit tenant, action and operator database access\n");
  process.exitCode = 1;
});
