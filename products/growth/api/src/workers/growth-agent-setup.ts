import { growthAgentPublication, growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5, growthAgentPublicationV6, growthAgentPublicationV7 } from "../agents/manifest.js";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { metrics } from "@opentelemetry/api";
import type { GrowthAgentProvisionRequest, GrowthAgentProvisionResult } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { provisionGrowthAgents } from "../agents/provisioning-client.js";
import { currentGrowthAgentSetup, type GrowthAgentSetupJob, type GrowthAgentSetupState } from "../agents/setup.js";
import { recordQueueAge, recordRetry, workerSpan } from "../observability/operations.js";
import type { WorkerLogger } from "./runtime.js";
const MAX_ATTEMPTS = 8, LEASE_SECONDS = 90;
const meter = metrics.getMeter("kasitek.growth.agent-setup");
const transitions = meter.createCounter("growth.agent_setup.transition.count");
const duration = meter.createHistogram("growth.agent_setup.duration", { unit: "s" });
const backlog = meter.createGauge("growth.agent_setup.backlog");
export function growthAgentSetupRetryDelay(attempt: number, random = Math.random()): number {
  return Math.min(300000, 1000 * 2 ** Math.min(Math.max(0, attempt - 1), 9)) * (0.75 + Math.max(0,Math.min(1,random)) * 0.5);
}
const setupPublications = [growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4,
  growthAgentPublicationV5, growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublication];
export function growthAgentSetupRequest(job: GrowthAgentSetupJob): GrowthAgentProvisionRequest {
  const publication = setupPublications.find(candidate => candidate.manifest.revision === job.defaultsRevision);
  return { version: "1", requestId: job.requestId, tenantId: job.orgId, defaultsRevision: job.defaultsRevision,
    modelProfileId: job.modelProfileId, modelProfileRevision: job.modelProfileRevision,
    ...(publication ? { publication, upgradeDefaults: true } : {}) };
}
export async function claimGrowthAgentSetups(core: CoreContext, owner: string, limit = 5): Promise<GrowthAgentSetupJob[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("Setup batch must be between 1 and 20");
  await core.pool.query(`UPDATE "GrowthAgentSetup" SET status='failed',"failureCode"='AGENT_SETUP_ATTEMPTS_EXHAUSTED',
    "leaseOwner"=NULL,"leaseExpiresAt"=NULL,"updatedAt"=NOW()
    WHERE attempts >= $1 AND (status='pending' OR (status='running' AND "leaseExpiresAt"<=NOW()))`,[MAX_ATTEMPTS]);
  return (await core.pool.query<GrowthAgentSetupJob>(`WITH due AS (
    SELECT "orgId" FROM "GrowthAgentSetup" WHERE attempts<$1 AND
      ((status='pending' AND "nextAttemptAt"<=NOW()) OR (status='running' AND "leaseExpiresAt"<=NOW()))
    ORDER BY "nextAttemptAt","orgId" LIMIT $2 FOR UPDATE SKIP LOCKED)
    UPDATE "GrowthAgentSetup" s SET status='running',attempts=attempts+1,generation=generation+1,
      "leaseOwner"=$3,"leaseExpiresAt"=NOW()+$4*INTERVAL '1 second',"updatedAt"=NOW()
    FROM due WHERE s."orgId"=due."orgId" RETURNING s.*`,[MAX_ATTEMPTS,limit,owner,LEASE_SECONDS])).rows;
}
export async function finishGrowthAgentSetup(core: CoreContext, job: GrowthAgentSetupJob,
  state: GrowthAgentSetupState, code: string | null, delayMs = 0): Promise<boolean> {
  return Boolean((await core.pool.query(`UPDATE "GrowthAgentSetup" SET status=$4,"failureCode"=$5,
    "nextAttemptAt"=NOW()+$6*INTERVAL '1 millisecond',"updatedAt"=NOW(),
    "completedAt"=CASE WHEN $4='ready' THEN NOW() ELSE "completedAt" END,"leaseOwner"=NULL,"leaseExpiresAt"=NULL
    WHERE "orgId"=$1 AND generation=$2 AND "leaseOwner"=$3 AND status='running' AND "leaseExpiresAt">NOW()`,
  [job.orgId,job.generation,job.leaseOwner,state,code,delayMs])).rowCount);
}
interface BatchOptions {
  owner?: string; limit?: number; signal?: AbortSignal;
  deliver?: (body: GrowthAgentProvisionRequest) => Promise<GrowthAgentProvisionResult>;
}
export async function processGrowthAgentSetupBatch(core: CoreContext, log: WorkerLogger, options: BatchOptions = {}): Promise<number> {
  const jobs = await claimGrowthAgentSetups(core, options.owner ?? randomUUID(), options.limit);
  await Promise.all(jobs.map(async job => {
    if (options.signal?.aborted) return;
    const body = growthAgentSetupRequest(job);
    const fields = { worker: "growth_agent_setup", organization_id: job.orgId, operation_id: job.requestId,
      generation: job.generation, attempt: job.attempts };
    log.info({ ...fields,event: "agent.setup.started" });
    recordQueueAge("growth_agent_setup", Math.max(0,(Date.now()-job.createdAt.getTime())/1000));
    let state: GrowthAgentSetupState = "pending", code: string | null = null;
    try {
      if (!await currentGrowthAgentSetup(core,body)) { state="cancelled"; code="AGENT_SETUP_INACTIVE"; }
      else {
        const result = await (options.deliver ?? (request => provisionGrowthAgents(core.config,request,{ signal: options.signal })))(body);
        state = result.state; code = result.code ?? null;
      }
    } catch (error) {
      if (options.signal?.aborted) return;
      const permanent = error instanceof ApiError && (error.status < 500 || error.code.startsWith("AGENT_SETUP_CONFIGURATION"));
      state = permanent ? "blocked" : job.attempts>=MAX_ATTEMPTS ? "failed" : "pending";
      code = error instanceof ApiError && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : "AGENT_SETUP_SERVICE_UNAVAILABLE";
    }
    const delay = state === "pending" ? growthAgentSetupRetryDelay(job.attempts) : 0;
    if (await finishGrowthAgentSetup(core,job,state,code,delay)) {
      transitions.add(1,{state,code: code??"NONE"});
      if (state === "pending") recordRetry("worker","growth_agent_setup",1);
      if (state === "ready") duration.record(Math.max(0,(Date.now()-job.createdAt.getTime())/1000));
      log.info({ ...fields,event: "agent.setup.transition", setup_state:state,failure_code:code,next_attempt_delay_ms:Math.round(delay) });
    } else log.info({...fields,event:"agent.setup.stale_completion"});
  }));
  return jobs.length;
}
export async function runGrowthAgentSetup(core: CoreContext, log: WorkerLogger, signal: AbortSignal): Promise<void> {
  const owner=randomUUID();
  log.info({event:"worker.started",worker:"growth_agent_setup"});
  while (!signal.aborted) {
    try {
      await workerSpan("growth_agent_setup.process_batch",()=>processGrowthAgentSetupBatch(core,log,{owner,signal}));
      const counts=await core.pool.query<{status:string;count:string;age:string|null}>(`SELECT status,count(*)::text,
        EXTRACT(EPOCH FROM NOW()-min("createdAt"))::text AS age FROM "GrowthAgentSetup" GROUP BY status`);
      const byState=new Map(counts.rows.map(row=>[row.status,row]));
      for (const status of ["pending","running","ready","blocked","failed","cancelled"]) {
        const row=byState.get(status);backlog.record(Number(row?.count??0),{state:status});
        if ((status==="pending"||status==="running")&&row?.age) recordQueueAge(`growth_agent_setup.${status}`,Number(row.age));
      }
    } catch (error) {
      if (!signal.aborted) log.error({event:"queue.item.failed",worker:"growth_agent_setup",error_type:error instanceof Error?error.name:"unknown"});
    }
    try { await sleep(2000,undefined,{signal}); } catch { if (!signal.aborted) throw new Error("Agent setup timer failed"); }
  }
}
