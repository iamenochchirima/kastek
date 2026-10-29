import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { CustomerFollowupConfig } from "./config";

export const FOLLOWUP_READINESS_MAX_AGE_SECONDS=45;
export const FOLLOWUP_SERVICE="AgentsCustomerFollowupV1";
export function followupConfigurationDigest(config:CustomerFollowupConfig):string {
  return createHash("sha256").update(JSON.stringify(["customer-followup-v1",config.apiKey,config.sender,config.publicUrl])).digest("hex");
}
async function registered(adminUrl:string,request:typeof fetch):Promise<boolean>{
  try{return(await request(`${adminUrl.replace(/\/$/,"")}/services/${FOLLOWUP_SERVICE}`,{signal:AbortSignal.timeout(2000)})).ok;}catch{return false;}
}
export async function publishFollowupReadiness(pool:Pool,input:{instanceId:string;configurationDigest:string;adminUrl:string},request:typeof fetch=fetch):Promise<void>{
  if(!await registered(input.adminUrl,request)){await pool.query("DELETE FROM agents_platform.customer_followup_runtime WHERE instance_id=$1",[input.instanceId]);return;}
  await pool.query(`INSERT INTO agents_platform.customer_followup_runtime(instance_id,configuration_digest,observed_at) VALUES($1,$2,now())
    ON CONFLICT(instance_id) DO UPDATE SET configuration_digest=excluded.configuration_digest,observed_at=excluded.observed_at`,[input.instanceId,input.configurationDigest]);
  await pool.query("DELETE FROM agents_platform.customer_followup_runtime WHERE observed_at<now()-interval '1 day'");
}
export async function customerFollowupReady(pool:Pool,config:CustomerFollowupConfig,adminUrl:string,request:typeof fetch=fetch):Promise<boolean>{
  const active=(await pool.query("SELECT 1 FROM agents_platform.customer_followup_runtime WHERE configuration_digest=$1 AND observed_at>now()-$2*interval '1 second' LIMIT 1",[followupConfigurationDigest(config),FOLLOWUP_READINESS_MAX_AGE_SECONDS])).rowCount;
  return Boolean(active)&&await registered(adminUrl,request);
}
