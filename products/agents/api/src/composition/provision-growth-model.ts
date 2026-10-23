import {Pool} from "pg";
import {GrowthExecutionService} from "../adapters/products/growth-execution";
import {growthServiceTrustFromEnvironment} from "../adapters/products/growth-service-auth";
import {provisionGrowthModel} from "../adapters/products/growth-model-provisioning";
import {ModelCredentialVault} from "../infrastructure/model-credential-vault";
import {connectionVaultFromEnvironment} from "../infrastructure/vault";
import {databasePoolOptions} from "../infrastructure/pool-policy";
async function main() {
  const trust=growthServiceTrustFromEnvironment(),vault=connectionVaultFromEnvironment();
  const tenantId=process.env.GROWTH_MODEL_TENANT_ID,providerId=process.env.GROWTH_MODEL_PROVIDER_ID,
    modelId=process.env.GROWTH_MODEL_ID,apiKey=process.env.GROWTH_MODEL_API_KEY;
  if(!trust||!vault||!tenantId||!providerId||!modelId||!apiKey||!process.env.AGENTS_DATABASE_URL)throw Error("Configure Growth trust, vault, database and explicit model setup variables");
  const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL,...databasePoolOptions("migration")});
  try {
    await new GrowthExecutionService(pool,trust).ensureTenant({tenantId});
    const result=await provisionGrowthModel(pool,new ModelCredentialVault(vault),{tenantId,providerId,modelId,apiKey,
      ...(process.env.GROWTH_MODEL_ENDPOINT?{endpoint:process.env.GROWTH_MODEL_ENDPOINT}:{})});
    console.log(JSON.stringify({event:"growth_model_configured",...result}));
  } finally {await pool.end();}
}
if(require.main===module)void main().catch(()=>{console.error("Growth model setup failed; check configuration and provider metadata");process.exitCode=1;});
