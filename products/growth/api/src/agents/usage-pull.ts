import type { Pool } from "pg";
import type { CoreConfig } from "../config.js";
import { recordMeterUsage } from "../services/billing.js";
import { readGrowthUsageFeed } from "./usage-feed.js";

/**
 * Pull settled task usage from the Agents service and record it for billing.
 * The Agents service is the source of truth for settlement, so billing does not
 * depend on a client later opening the task.
 */
export async function pullGrowthAgentUsage(
  pool: Pool,
  config: CoreConfig,
  limit = 100,
): Promise<number> {
  const orgs = await pool.query<{ orgId: string }>(
    `SELECT "orgId" FROM "GrowthAgentSetup" WHERE status='ready' ORDER BY "orgId" LIMIT 500`,
  );
  let recorded = 0;
  for (const org of orgs.rows) {
    const cursor = await pool.query<{ since: string }>(
      `SELECT since FROM "GrowthAgentUsageCursor" WHERE "orgId"=$1`,
      [org.orgId],
    );
    let since = cursor.rows[0]?.since ?? null;
    for (let page = 0; page < 10; page++) {
      const feed = await readGrowthUsageFeed(config, org.orgId, since, limit);
      if (!feed.items.length) break;
      for (const item of feed.items) {
        const tokens = Math.max(0, Math.round(item.accountedTokens));
        const cost = Number(item.managedCostMicros);
        if (Number.isFinite(cost) && cost > 0)
          await recordMeterUsage(
            pool, org.orgId, "growth_ai_cost", cost, "growth_agent_task", item.taskId,
            `growth:agent-task:${item.taskId}:cost`,
            { unit: "micro_usd", outcome: item.outcome },
          );
        if (tokens > 0)
          await recordMeterUsage(
            pool, org.orgId, "growth_agent_tokens", tokens, "growth_agent_task", item.taskId,
            `growth:agent-task:${item.taskId}:tokens`,
            { outcome: item.outcome },
          );
        recorded += 1;
      }
      if (!feed.nextSince) break;
      since = feed.nextSince;
      await pool.query(
        `INSERT INTO "GrowthAgentUsageCursor"("orgId",since) VALUES($1,$2)
         ON CONFLICT ("orgId") DO UPDATE SET since=EXCLUDED.since, "updatedAt"=now()`,
        [org.orgId, since],
      );
      if (feed.items.length < limit) break;
    }
  }
  return recorded;
}
