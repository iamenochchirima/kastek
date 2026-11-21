import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { FirecrawlClient, FirecrawlError, type FirecrawlConfig } from "../../adapters/providers/firecrawl/client";
import { KnowledgeStore, requireKnowledgeMember, type KnowledgeScope } from "../../platform/knowledge";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { SOURCE_LIMITS } from "../../contracts/source-contracts";
import { publicAddress } from "../../infrastructure/connected-network";
import { transaction } from "../../infrastructure/database";
import { assertMcpJobAuthority } from "../../infrastructure/mcp-job-authority";
import { assertAgentsBillingLimit } from "../billing/billing";

export const websiteCrawlInput = z.strictObject({ operationId: z.string().min(1).max(128), url: z.string().trim().min(1).max(2048), limit: z.number().int().min(1).max(100).default(20), maxDiscoveryDepth: z.number().int().min(0).max(10).default(2) });
export const websiteCrawlImportInput = z.strictObject({ operationId: z.string().min(1).max(128), pageIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100) });
type CrawlPage = { id: string; url: string; title: string; markdown: string };
type Row = Record<string, any>;
const unavailable = () => new PlatformError("WEBSITE_CRAWL_NOT_FOUND",404,"Website import not found");
export function websiteCrawlUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { throw new PlatformError("DESTINATION_DENIED",400,"Enter a public website"); }
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash || url.hostname === "localhost" || url.hostname.endsWith(".localhost")) throw new PlatformError("DESTINATION_DENIED",400,"Enter a public HTTPS website");
  return url.href;
}
async function publicTarget(url: string) {
  const host = new URL(url).hostname.replace(/^\[|\]$/g,"");
  const addresses = await lookup(host,{ all:true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new PlatformError("DESTINATION_DENIED",400,"Enter a public website");
}
function dto(row: Row) {
  return { id: row.id as string, url: row.url as string, state: row.state as string, pages: row.pages as CrawlPage[], total: row.total as number,
    completed: row.completed as number, errorCode: row.error_code as string | null, importJobId: row.import_job_id as string | null, createdAt: new Date(row.created_at).toISOString() };
}
export class WebsiteCrawlStore {
  private client?: FirecrawlClient;
  constructor(readonly pool: Pool, private readonly knowledge: KnowledgeStore, readonly config?: FirecrawlConfig) { if(config)this.client=new FirecrawlClient(config); }
  get available() { return Boolean(this.client); }
  private async authorize(db: PoolClient,scope: KnowledgeScope,agentId:string) {
    z.uuid().parse(agentId); await requireKnowledgeMember(db,scope,true);
    const agent=(await db.query("SELECT id,offering,setup FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 FOR SHARE",[scope.organizationId,agentId])).rows[0];
    if(!agent)throw unavailable();
    if(!["faq","customer-service"].includes(agent.offering) || agent.setup && !agent.setup.responsibilities.some((value:string)=>["answer-questions","customer-support"].includes(value)))
      throw new PlatformError("WEBSITE_KNOWLEDGE_UNSUPPORTED",409,"Website knowledge is not enabled for this agent");
  }
  private async row(db: PoolClient,scope: KnowledgeScope,agentId:string,id:string,lock=false) {
    await this.authorize(db,scope,agentId); z.uuid().parse(id);
    const row=(await db.query(`SELECT * FROM agents_platform.website_crawls WHERE organization_id=$1 AND agent_id=$2 AND id=$3 ${lock?"FOR UPDATE":""}`,[scope.organizationId,agentId,id])).rows[0];
    if(!row)throw unavailable();return row;
  }
  async start(scope:KnowledgeScope,agentId:string,raw:unknown) {
    const input=websiteCrawlInput.parse(raw),url=websiteCrawlUrl(input.url),digest=requestDigest({...input,url,agentId});
    const used=(await this.pool.query<{used:string}>(`SELECT COALESCE(SUM(page_limit),0)::text AS used FROM agents_platform.website_crawls WHERE organization_id=$1 AND created_at>=date_trunc('month',now())`,[scope.organizationId])).rows[0]?.used??"0";
    await assertAgentsBillingLimit(this.pool,scope.organizationId,"limit.crawl_pages",Number(used),input.limit);
    return transaction(this.pool,async db=>{
      await this.authorize(db,scope,agentId);
      const connectionId=(scope as KnowledgeScope & {connectionId?:string}).connectionId??null;
      await assertMcpJobAuthority(db,{mcp_connection_id:connectionId,organization_id:scope.organizationId,account_id:scope.accountId});
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      const previous=(await db.query("SELECT * FROM agents_platform.website_crawls WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3",[scope.organizationId,scope.accountId,input.operationId])).rows[0];
      if(previous){if(previous.request_digest!==digest||previous.mcp_connection_id!==connectionId)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request identity conflict");return dto(previous);}
      if(!this.config)throw new PlatformError("WEBSITE_CRAWL_UNAVAILABLE",503,"Website import is unavailable");
      await publicTarget(url);
      const active=await db.query("SELECT 1 FROM agents_platform.website_crawls WHERE organization_id=$1 AND state IN ('queued','submitting','scraping') LIMIT 2",[scope.organizationId]);
      if(active.rowCount!>=2)throw new PlatformError("WEBSITE_CRAWL_BUSY",429,"Two website imports are already running");
      return dto((await db.query(`INSERT INTO agents_platform.website_crawls(id,organization_id,agent_id,account_id,operation_id,request_digest,url,provider_origin,state,page_limit,discovery_depth,mcp_connection_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11) RETURNING *`,[randomUUID(),scope.organizationId,agentId,scope.accountId,input.operationId,digest,url,this.config.url,input.limit,input.maxDiscoveryDepth,connectionId])).rows[0]);
    });
  }
  async get(scope:KnowledgeScope,agentId:string,id:string){return transaction(this.pool,async db=>dto(await this.row(db,scope,agentId,id)));}
  async list(scope:KnowledgeScope,agentId:string){return transaction(this.pool,async db=>{await this.authorize(db,scope,agentId);return(await db.query("SELECT * FROM agents_platform.website_crawls WHERE organization_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 10",[scope.organizationId,agentId])).rows.map(dto);});}
  async cancel(scope:KnowledgeScope,agentId:string,id:string) {
    const row=await transaction(this.pool,async db=>{
      const row=await this.row(db,scope,agentId,id,true);
      if(row.import_job_id || row.import_digest)throw new PlatformError("WEBSITE_CRAWL_IMPORTED",409,"Manage this import in Knowledge");
      await db.query("UPDATE agents_platform.website_crawls SET state='cancelled',updated_at=now() WHERE id=$1",[id]);return row;
    });
    if(row.provider_id && row.provider_origin===this.config?.url)await this.client?.cancel(row.provider_id).catch(()=>undefined);
    return this.get(scope,agentId,id);
  }
  async import(scope:KnowledgeScope,agentId:string,id:string,raw:unknown,profileRelease?:string) {
    const input=websiteCrawlImportInput.parse(raw),ids=[...new Set(input.pageIds)].sort(),digest=requestDigest(ids);
    // Reserve the exact selection before any object writes. A retry resumes this reservation.
    const reserved=await transaction(this.pool,async db=>{
      const row=await this.row(db,scope,agentId,id,true);
      await assertMcpJobAuthority(db,row);
      if(row.state!=="completed")throw new PlatformError("WEBSITE_CRAWL_NOT_READY",409,"Wait for the website import to finish");
      if(row.import_digest && row.import_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"This crawl was imported with a different selection");
      if(row.import_job_id)return {kind:"existing" as const,existingJobId:row.import_job_id as string,crawl:dto(row)};
      const pages=(row.pages as CrawlPage[]).filter(page=>ids.includes(page.id));
      if(pages.length!==ids.length)throw new PlatformError("INVALID_INPUT",400,"Choose pages from this website import");
      const content=pages.map(page=>`# ${page.title}\n\nSource: ${page.url}\n\n${page.markdown}`).join("\n\n---\n\n");
      // Existing reservations must keep their original parser even if runtime availability changes.
      const selectedProfile=row.import_digest ? row.import_profile_release as string|null : profileRelease ?? null;
      if (!selectedProfile) {
        const agent=(await db.query<{kind:string|null}>("SELECT draft->'retrievalProfile'->>'kind' AS kind FROM agents_platform.agents WHERE organization_id=$1 AND id=$2",[scope.organizationId,agentId])).rows[0];
        if(agent?.kind==="hybrid-v1")throw new PlatformError("DOCUMENT_RUNTIME_UNAVAILABLE",503,"This agent requires semantic indexing, which is unavailable");
      }
      if(Buffer.byteLength(content,"utf8")>(selectedProfile?SOURCE_LIMITS.textBytes:262144))throw new PlatformError("SOURCE_SIZE_INVALID",413,"Select fewer pages for this knowledge source");
      if(!row.import_digest)await db.query("UPDATE agents_platform.website_crawls SET import_digest=$2,import_profile_release=$3,updated_at=now() WHERE id=$1",[id,digest,selectedProfile]);
      return {kind:"new" as const,content,title:new URL(row.url).hostname,connectionId:row.mcp_connection_id as string|null,profileRelease:selectedProfile};
    });
    if (reserved.kind==="existing") return {crawl:reserved.crawl,job:await this.knowledge.getJob(scope,reserved.existingJobId)};
    const importScope={...scope,...(reserved.connectionId?{connectionId:reserved.connectionId}:{})};
    const job=reserved.profileRelease
      ? await this.knowledge.admitUpload(importScope,{operationId:`website-crawl:${id}`,title:reserved.title,contentType:"text/markdown",content:Buffer.from(reserved.content,"utf8"),parserRelease:reserved.profileRelease,embeddingRelease:reserved.profileRelease})
      : await this.knowledge.admitText(importScope,{operationId:`website-crawl:${id}`,title:reserved.title,contentType:"text/markdown",text:reserved.content});
    const crawl=await transaction(this.pool,async db=>{
      const row=await this.row(db,scope,agentId,id,true);
      await assertMcpJobAuthority(db,row);
      if(row.state!=="completed"||row.import_digest!==digest||(row.import_job_id&&row.import_job_id!==job.id))throw new PlatformError("INGESTION_INVALIDATED",409,"The source import changed before completion");
      return dto((await db.query("UPDATE agents_platform.website_crawls SET import_job_id=$2,updated_at=now() WHERE id=$1 RETURNING *",[id,job.id])).rows[0]);
    });
    return {crawl,job};
  }
  /** Leases serialize dispatchers; uncertain POST submissions are never automatically repeated. */
  async tick() {
    const row=await transaction(this.pool,async db=>{
      const row=(await db.query(`SELECT * FROM agents_platform.website_crawls WHERE state IN ('queued','submitting','scraping') AND (lease_until IS NULL OR lease_until<now()) AND updated_at<now()-interval '2 seconds' ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1`)).rows[0];
      if(!row)return;
      await db.query("UPDATE agents_platform.website_crawls SET lease_until=now()+interval '2 minutes',state=CASE WHEN state='queued' THEN 'submitting' ELSE state END WHERE id=$1",[row.id]);return row;
    });
    if(!row)return;
    let remoteId=row.provider_id as string|undefined;
    try {
      await transaction(this.pool,async db=>{await this.authorize(db,{organizationId:row.organization_id,accountId:row.account_id},row.agent_id);await assertMcpJobAuthority(db,row);});
      if(new Date(row.deadline).getTime()<Date.now())throw new FirecrawlError("WEBSITE_CRAWL_DEADLINE");
      if(!this.client || row.provider_origin!==this.config?.url)throw new FirecrawlError("WEBSITE_CRAWL_CONFIGURATION_CHANGED");
      if(row.state==="submitting")throw new FirecrawlError("WEBSITE_CRAWL_SUBMISSION_UNCERTAIN");
      if(row.state==="queued"){
        await publicTarget(row.url);
        remoteId=(await this.client.startCrawl(row.url,{limit:row.page_limit,maxDiscoveryDepth:row.discovery_depth})).id;
        const updated=await this.pool.query("UPDATE agents_platform.website_crawls SET state='scraping',provider_id=$2,updated_at=now(),lease_until=NULL WHERE id=$1 AND state='submitting'",[row.id,remoteId]);
        if(!updated.rowCount)await this.client.cancel(remoteId).catch(()=>undefined);
        return;
      }
      const result=await this.client.status(remoteId!);
      await transaction(this.pool,async db=>{await this.authorize(db,{organizationId:row.organization_id,accountId:row.account_id},row.agent_id);await assertMcpJobAuthority(db,row);});
      // Firecrawl returns a polling cursor even before any pages are available.
      // Poll our pinned job path; never follow a credential-bearing provider URL.
      if(result.next && result.status==="completed")throw new FirecrawlError("WEBSITE_CRAWL_RESULT_LIMIT");
      const pages:CrawlPage[]=[];let bytes=0;
      for(const value of result.data){
        if(!value.markdown?.trim())continue;
        const url=websiteCrawlUrl(String(value.metadata?.sourceURL??value.metadata?.url??""));
        if(new URL(url).hostname!==new URL(row.url).hostname)continue;
        const id=createHash("sha256").update(url).digest("hex");if(pages.some(page=>page.id===id))continue;
        const title=String(value.metadata?.title??new URL(url).pathname).slice(0,200),markdown=value.markdown;
        bytes+=Buffer.byteLength(markdown);if(bytes>10*1024*1024 || pages.length>=row.page_limit)throw new FirecrawlError("WEBSITE_CRAWL_RESULT_LIMIT");
        pages.push({id,url,title,markdown});
      }
      await this.pool.query(`UPDATE agents_platform.website_crawls SET state=$2,total=$3,completed=$4,pages=$5,error_code=$6,updated_at=now(),lease_until=NULL,poll_failures=0 WHERE id=$1 AND state='scraping'`,[row.id,result.status,result.total,result.completed,JSON.stringify(pages),result.status==="failed"?"WEBSITE_CRAWL_PROVIDER_FAILED":null]);
    }catch(error){
      if(row.state==="scraping" && error instanceof FirecrawlError && ["FIRECRAWL_UNAVAILABLE","FIRECRAWL_TIMEOUT","FIRECRAWL_RATE_LIMIT"].includes(error.code) && row.poll_failures<5 && new Date(row.deadline).getTime()>Date.now()){
        await this.pool.query("UPDATE agents_platform.website_crawls SET poll_failures=poll_failures+1,updated_at=now(),lease_until=now()+interval '10 seconds' WHERE id=$1 AND state='scraping'",[row.id]);return;
      }
      if(remoteId && row.provider_origin===this.config?.url)await this.client?.cancel(remoteId).catch(()=>undefined);
      await this.pool.query("UPDATE agents_platform.website_crawls SET state='failed',error_code=$2,updated_at=now(),lease_until=NULL WHERE id=$1 AND state IN ('submitting','scraping')",[row.id,error instanceof FirecrawlError?error.code:error instanceof PlatformError?error.code:"WEBSITE_CRAWL_FAILED"]);
    }
  }
}
export function startWebsiteCrawlDispatcher(crawls:WebsiteCrawlStore,onError:(error:unknown)=>void=()=>undefined){
  let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;let running:Promise<void>;
  const run=async()=>{try{await crawls.tick();}catch(error){onError(error);}finally{if(!stopped){timer=setTimeout(()=>{running=run();},2000);timer.unref();}}};
  running=run();return async()=>{stopped=true;if(timer)clearTimeout(timer);await running;};
}
