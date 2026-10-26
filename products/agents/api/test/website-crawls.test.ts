import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FirecrawlClient, FirecrawlError } from "../src/adapters/providers/firecrawl/client";
import { KnowledgeStore } from "../src/capabilities/knowledge/knowledge";
import { PlatformStore } from "../src/product/agents/store";
import { WebsiteCrawlStore, websiteCrawlUrl } from "../src/product/agents/website-crawls";
import { setupPlatformSchema } from "../src/composition/setup";
import { dropClosedTestDatabase } from "./support/database-cleanup";
vi.mock("node:dns/promises",()=>({lookup:vi.fn(async()=>[{address:"93.184.215.14",family:4}])}));
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
describe("website crawl URL admission",()=>{
 it("normalizes bare domains and denies non-public URL forms",()=>{
  expect(websiteCrawlUrl("example.com/about")).toBe("https://example.com/about");
  for(const url of ["http://example.com","https://user:pass@example.com","https://localhost","https://example.com:8443","https://example.com/#x"])expect(()=>websiteCrawlUrl(url)).toThrow();
 });
});
(databaseUrl?describe:describe.skip)("durable tenant-scoped website crawl review",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,knowledge:KnowledgeStore,store:WebsiteCrawlStore;
 const database=`agents_crawl_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>();
 const config={url:"https://crawler.example",timeoutMs:1000};
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
  const target=new URL(databaseUrl!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);
  platform=new PlatformStore(pool);knowledge=new KnowledgeStore(pool,{async get(key){return objects.get(key)!;},async put(key,bytes){objects.set(key,Buffer.from(bytes));},async delete(key){objects.delete(key);}});
  store=new WebsiteCrawlStore(pool,knowledge,config);
 });
 afterAll(async()=>{vi.restoreAllMocks();await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 beforeEach(()=>vi.restoreAllMocks());
 async function fixture(){
  const account=await platform.ensureAccount({issuer:"https://crawl.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const org=await platform.createOrganization(account.id,"Crawl"),scope={accountId:account.id,organizationId:org.id};
  const agent=await platform.createConfiguredAgent({...scope,name:"FAQ",offering:"faq"});return{scope,agentId:agent.agent.id};
 }
 async function tick(){await pool.query("UPDATE agents_platform.website_crawls SET updated_at=now()-interval '3 seconds',lease_until=NULL WHERE state IN ('queued','scraping')");await store.tick();}
 function provider(){
  const start=vi.spyOn(FirecrawlClient.prototype,"startCrawl").mockResolvedValue({id:"provider-job"});
  const cancel=vi.spyOn(FirecrawlClient.prototype,"cancel").mockResolvedValue();
  const status=vi.spyOn(FirecrawlClient.prototype,"status").mockResolvedValue({status:"completed",total:1,completed:1,data:[{markdown:"We offer booking support.",metadata:{sourceURL:"https://example.com/services",title:"Services"}}]});return{start,cancel,status};
 }
 it("resumes jobs, imports selected evidence once through canonical ingestion, and leaves it unapproved",async()=>{
  const {scope,agentId}=await fixture(),remote=provider(),input={operationId:randomUUID(),url:"example.com"};
  const crawl=await store.start(scope,agentId,input);expect((await store.start(scope,agentId,input)).id).toBe(crawl.id);
  await expect(store.start(scope,agentId,{...input,url:"other.example"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  await tick();await tick();const complete=await store.get(scope,agentId,crawl.id);expect(complete.state).toBe("completed");expect(remote.start).toHaveBeenCalledTimes(1);
  expect((await store.list(scope,agentId))[0].id).toBe(crawl.id);
  const selected={operationId:randomUUID(),pageIds:[complete.pages[0].id]};
  const imported=await store.import(scope,agentId,crawl.id,selected,"document-test-v1");
  expect((await store.import(scope,agentId,crawl.id,selected,"document-test-v1")).job.id).toBe(imported.job.id);
  const sources=await knowledge.list(scope);expect(sources).toHaveLength(1);expect(sources[0].visibility).toBe("private");expect(sources[0].revisions).toHaveLength(0);
  expect([...objects.values()].map(value=>Buffer.from(value).toString()).join()).toContain("Source: https://example.com/services");
  expect((await pool.query("SELECT count(*) FROM agents_platform.ingestion_outbox WHERE job_id=$1",[imported.job.id])).rows[0].count).toBe("1");
 });
 it("polls an active Firecrawl cursor without following its URL or failing the crawl",async()=>{
  const{scope,agentId}=await fixture(),remote=provider();const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});await tick();
  remote.status.mockResolvedValueOnce({status:"scraping",total:0,completed:0,data:[],next:"http://127.0.0.1:3002/v2/crawl/provider-job?skip=0"});
  await tick();expect((await store.get(scope,agentId,crawl.id)).state).toBe("scraping");
  await tick();expect((await store.get(scope,agentId,crawl.id)).state).toBe("completed");
  expect(remote.status.mock.calls).toEqual([["provider-job"],["provider-job"]]);
 });
 it("reports completed paginated results rather than silently importing a partial site",async()=>{
  const{scope,agentId}=await fixture(),remote=provider();const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});await tick();
  remote.status.mockResolvedValueOnce({status:"completed",total:2,completed:2,data:[{markdown:"first",metadata:{sourceURL:"https://example.com/"}}],next:"https://untrusted.example/steal-credential"});
  await tick();expect((await store.get(scope,agentId,crawl.id)).errorCode).toBe("WEBSITE_CRAWL_RESULT_LIMIT");
  expect(remote.status.mock.calls).toEqual([["provider-job"]]);
 });
 it("fences cancellation while the provider submission is in flight",async()=>{
  const{scope,agentId}=await fixture();const remote=provider();
  const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});
  remote.start.mockImplementation(async()=>{await store.cancel(scope,agentId,crawl.id);return{id:"late-provider-job"};});
  await tick();expect((await store.get(scope,agentId,crawl.id)).state).toBe("cancelled");expect(remote.cancel).toHaveBeenCalledWith("late-provider-job");
  await expect(store.import(scope,agentId,crawl.id,{operationId:randomUUID(),pageIds:["0".repeat(64)]},"x")).rejects.toMatchObject({code:"WEBSITE_CRAWL_NOT_READY"});
 });
 it("does not resubmit uncertain submissions after a restart",async()=>{
  const{scope,agentId}=await fixture(),remote=provider();const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});
  await pool.query("UPDATE agents_platform.website_crawls SET state='submitting',updated_at=now()-interval '3 seconds' WHERE id=$1",[crawl.id]);
  await store.tick();expect((await store.get(scope,agentId,crawl.id)).errorCode).toBe("WEBSITE_CRAWL_SUBMISSION_UNCERTAIN");expect(remote.start).not.toHaveBeenCalled();
 });
 it("does not reroute existing work after switching provider configuration",async()=>{
  const{scope,agentId}=await fixture(),remote=provider();const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});
  await tick();const changed=new WebsiteCrawlStore(pool,knowledge,{...config,url:"https://api.firecrawl.dev"});
  await pool.query("UPDATE agents_platform.website_crawls SET updated_at=now()-interval '3 seconds' WHERE id=$1",[crawl.id]);await changed.tick();
  expect((await store.get(scope,agentId,crawl.id)).errorCode).toBe("WEBSITE_CRAWL_CONFIGURATION_CHANGED");expect(remote.status).not.toHaveBeenCalled();
 });
 it("retries only bounded status reads and eventually fails unavailable providers",async()=>{
  const{scope,agentId}=await fixture(),remote=provider();const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});await tick();
  remote.status.mockRejectedValue(new FirecrawlError("FIRECRAWL_UNAVAILABLE"));
  await tick();expect((await store.get(scope,agentId,crawl.id)).state).toBe("scraping");
  for(let i=0;i<5;i++)await tick();expect((await store.get(scope,agentId,crawl.id)).state).toBe("failed");expect(remote.start).toHaveBeenCalledTimes(1);
 });
 it("does not publish a late status after cancellation or owner revocation",async()=>{
  const{scope,agentId}=await fixture(),remote=provider();const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});await tick();
  remote.status.mockImplementation(async()=>{await store.cancel(scope,agentId,crawl.id);return{status:"completed",total:1,completed:1,data:[{markdown:"late",metadata:{sourceURL:"https://example.com"}}]};});
  await tick();expect((await store.get(scope,agentId,crawl.id)).state).toBe("cancelled");
  const second=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});await tick();
  remote.status.mockImplementation(async()=>{await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[scope.organizationId,scope.accountId]);return{status:"completed",total:1,completed:1,data:[{markdown:"late",metadata:{sourceURL:"https://example.com"}}]};});
  await tick();const saved=(await pool.query("SELECT state,pages FROM agents_platform.website_crawls WHERE id=$1",[second.id])).rows[0];expect(saved).toEqual({state:"failed",pages:[]});
 });
 it("denies revoked owners, other tenants, and invalid page selection",async()=>{
  const{scope,agentId}=await fixture(),other=await fixture();provider();const crawl=await store.start(scope,agentId,{operationId:randomUUID(),url:"example.com"});await tick();await tick();
  await expect(store.get(other.scope,agentId,crawl.id)).rejects.toMatchObject({code:"WEBSITE_CRAWL_NOT_FOUND"});
  await expect(store.import(scope,agentId,crawl.id,{operationId:randomUUID(),pageIds:["0".repeat(64)]},"x")).rejects.toMatchObject({code:"INVALID_INPUT"});
  await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[scope.organizationId,scope.accountId]);
  await expect(store.get(scope,agentId,crawl.id)).rejects.toMatchObject({code:"ACCESS_DENIED"});
 });
});
