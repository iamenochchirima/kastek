import { config as loadEnvironment } from "dotenv";
import { fileURLToPath } from "node:url";
import { loadServiceEnvironment } from "@kasitek-labs/server-support/config";
import { readConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { backfillGrowthAgentSetup, retryGrowthAgentSetup, readGrowthAgentSetupMetrics, upgradeGrowthAgentDefaults } from "../src/agents/setup.js";

loadServiceEnvironment(fileURLToPath(new URL("../.env",import.meta.url)),path=>loadEnvironment(path===undefined?{}:{path}));
const [operation,argument,...rest]=process.argv.slice(2);
if (rest.length || !["backfill","retry","cancel","status","upgrade-defaults"].includes(operation??""))
  throw new Error("Usage: agent-setup.ts backfill [1-1000] | retry <organisation-id> | cancel <organisation-id> | upgrade-defaults <organisation-id> | status");
const config=readConfig(),pool=createPool(config),core={pool,config};
try {
  if (operation==="backfill") console.info({enqueued:await backfillGrowthAgentSetup(core,argument===undefined?100:Number(argument))});
  else if (operation==="retry") {
    if (!argument) throw new Error("Organisation ID is required");
    console.info({retried:await retryGrowthAgentSetup(core,argument)});
  } else if (operation==="upgrade-defaults") {
    if (!argument) throw new Error("Organisation ID is required");
    console.info({enqueued:await upgradeGrowthAgentDefaults(core,argument)});
  } else if (operation==="cancel") {
    if (!argument) throw new Error("Organisation ID is required");
    const result=await pool.query(`UPDATE "GrowthAgentSetup" SET status='cancelled',"failureCode"='AGENT_SETUP_CANCELLED',
      generation=generation+1,"leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=NOW() WHERE "orgId"=$1`,[argument]);
    console.info({cancelled:Boolean(result.rowCount)});
  } else {
    if (argument) throw new Error("status takes no arguments");
    console.info(await readGrowthAgentSetupMetrics(pool));
  }
} finally { await pool.end(); }
