import {dropClosedTestDatabase} from "./support/database-cleanup";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {PrivateObjectStore} from "../src/infrastructure/object-store";
import {KnowledgeStore} from "../src/platform/knowledge/knowledge";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {textDigest} from "../src/contracts/source-contracts";
import {reapSourceObjects,writeSourceObject,type SourceObjectWrite} from "../src/platform/knowledge/source-objects";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("durable source object ownership with PostgreSQL and explicit storage faults",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,knowledge:KnowledgeStore;
 const database=`agents_source_objects_${randomUUID().replaceAll("-","")}`,bodies=new Map<string,Uint8Array>();let puts=0,deletes=0;
 const storage:PrivateObjectStore={async put(key,bytes){puts++;bodies.set(key,Buffer.from(bytes));},async get(key){const bytes=bodies.get(key);if(!bytes)throw Error("Missing fixture object");return bytes;},async delete(key){deletes++;bodies.delete(key);}};
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href,max:10});await setupPlatformSchema(pool);platform=new PlatformStore(pool);knowledge=new KnowledgeStore(pool,storage);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){const owner=await platform.ensureAccount({issuer:"http://source/objects",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(owner.id,"Private source objects");const scope={organizationId:org.id,accountId:owner.id};const job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Guide",contentType:"text/plain",content:Buffer.from("Source fixture"),parserRelease:"fixture-v1"});return{scope,job};}
 function stage(f:Awaited<ReturnType<typeof fixture>>,text="stage receipt"):SourceObjectWrite {const bytes=Buffer.from(text);return{jobId:f.job.id,key:`knowledge/${f.scope.organizationId}/${f.job.id}/stages/${randomUUID()}/${textDigest(bytes)}`,bytes,contentType:"application/json",kind:"stage"};}
 it("records ownership before PUT and reuses the acknowledged immutable object",async()=>{
  const f=await fixture(),input=stage(f),before=puts;
  const checked={...storage,async put(key:string,bytes:Uint8Array,type:string){const row=(await pool.query("SELECT * FROM agents_platform.source_objects WHERE object_key=$1",[key])).rows[0];expect(row.state).toBe("writing");expect(row.job_id).toBe(f.job.id);expect(new Date(row.write_lease_until).getTime()).toBeGreaterThan(Date.now());await storage.put(key,bytes,type);}};
  await writeSourceObject(pool,checked,input);await writeSourceObject(pool,checked,input);expect(puts-before).toBe(1);
  await expect(writeSourceObject(pool,checked,{...input,bytes:Buffer.from("different content")})).rejects.toMatchObject({code:"SOURCE_OBJECT_CONFLICT"});
 });
 it("joins concurrent duplicate uploads while the first physical PUT is in flight",async()=>{
  const owner=await platform.ensureAccount({issuer:"http://source/objects",subject:randomUUID(),email:"parallel@example.test",displayName:"Owner"}),org=await platform.createOrganization(owner.id,"Parallel upload"),scope={organizationId:org.id,accountId:owner.id};
  let entered!:()=>void,release!:()=>void,physical=0;const ready=new Promise<void>(done=>entered=done),barrier=new Promise<void>(done=>release=done);
  const shared=new KnowledgeStore(pool,{...storage,async put(key,bytes,type){physical++;entered();await barrier;await storage.put(key,bytes,type);}}),input={operationId:randomUUID(),title:"Concurrent guide",contentType:"text/plain",content:Buffer.from("One immutable upload"),parserRelease:"fixture-v1"};
  const first=shared.admitUpload(scope,input);await ready;const second=shared.admitUpload(scope,input);
  await new Promise(done=>setTimeout(done,40));release();const [a,b]=await Promise.all([first,second]);
  expect(a.id).toBe(b.id);expect(a.revisionId).toBe(b.revisionId);expect(physical).toBe(1);
  expect((await pool.query("SELECT count(*) FROM agents_platform.source_objects WHERE job_id=$1",[a.id])).rows[0].count).toBe("1");
 });
 it("allows nonblocking cancellation during PUT and cleans the recorded late write",async()=>{
  const f=await fixture(),input=stage(f);let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(done=>entered=done),barrier=new Promise<void>(done=>release=done);
  const delayed={...storage,async put(key:string,bytes:Uint8Array,type:string){entered();await barrier;await storage.put(key,bytes,type);}};
  const writing=writeSourceObject(pool,delayed,input),rejected=expect(writing).rejects.toMatchObject({code:"INGESTION_INVALIDATED"});await ready;
  const started=Date.now();await knowledge.cancel(f.scope,f.job.id);expect(Date.now()-started).toBeLessThan(500);
  await reapSourceObjects(pool,storage);expect((await pool.query("SELECT state FROM agents_platform.source_objects WHERE object_key=$1",[input.key])).rows[0].state).toBe("writing");
  release();await rejected;await reapSourceObjects(pool,storage);expect(bodies.has(input.key)).toBe(false);expect((await pool.query("SELECT state FROM agents_platform.source_objects WHERE object_key=$1",[input.key])).rows[0].state).toBe("deleted");
  bodies.set(input.key,input.bytes);await reapSourceObjects(pool,storage,{now:new Date(Date.now()+61000)});expect(bodies.has(input.key)).toBe(false);
 });
 it("retains unknown write leases until expiry and keeps retryable tombstones",async()=>{
  const f=await fixture(),input=stage(f),unknown={...storage,async put(key:string,bytes:Uint8Array,type:string){await storage.put(key,bytes,type);throw Error("Injected unknown PUT outcome");}};
  await expect(writeSourceObject(pool,unknown,input)).rejects.toThrow("unknown PUT");await knowledge.cancel(f.scope,f.job.id);
  await reapSourceObjects(pool,storage);expect(bodies.has(input.key)).toBe(true);
  await pool.query("UPDATE agents_platform.source_objects SET write_lease_until=now()-interval '1 second' WHERE object_key=$1",[input.key]);await reapSourceObjects(pool,storage);expect(bodies.has(input.key)).toBe(false);
  const row=(await pool.query("SELECT state,next_cleanup_at FROM agents_platform.source_objects WHERE object_key=$1",[input.key])).rows[0];expect(row.state).toBe("deleted");expect(row.next_cleanup_at).toBeTruthy();
  bodies.set(input.key,input.bytes);await reapSourceObjects(pool,storage,{now:new Date(Date.now()+61000)});expect(bodies.has(input.key)).toBe(false);
 });
 it("retains raw bodies and stage receipts for replay, then removes them and honors withdrawal",async()=>{
  const f=await fixture(),input=stage(f);await writeSourceObject(pool,storage,input);const text="Published source fixture";
  await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[f.job.id]);await knowledge.publishExtraction(f.job.id,{text,normalizerRelease:"fixture-v1",acquiredAt:new Date().toISOString(),chunks:[{id:randomUUID(),revisionId:f.job.revisionId,ordinal:0,start:0,end:text.length,page:1,section:null,text,digest:textDigest(text),tokens:8}]});
  const revision=(await pool.query("SELECT raw_key,text_key FROM agents_platform.source_revisions WHERE id=$1",[f.job.revisionId])).rows[0];await reapSourceObjects(pool,storage);expect(bodies.has(input.key)).toBe(true);expect(bodies.has(revision.raw_key)).toBe(true);expect(bodies.has(revision.text_key)).toBe(true);
  await reapSourceObjects(pool,storage,{now:new Date(Date.now()+8*86400000)});expect(bodies.has(input.key)).toBe(false);expect(bodies.has(revision.raw_key)).toBe(false);expect(bodies.has(revision.text_key)).toBe(true);
  await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"withdraw"});await reapSourceObjects(pool,storage);expect(bodies.has(revision.raw_key)).toBe(false);expect(bodies.has(revision.text_key)).toBe(false);
 });
 it("cleans unsealed text and retries failed DELETE without discarding ownership",async()=>{
  const f=await fixture(),bytes=Buffer.from("Unsealed extracted text"),input:SourceObjectWrite={jobId:f.job.id,key:`knowledge/${f.scope.organizationId}/${f.job.sourceId}/${f.job.revisionId}/${textDigest(bytes)}`,bytes,contentType:"text/plain",kind:"text"};await writeSourceObject(pool,storage,input);await knowledge.cancel(f.scope,f.job.id);
  const broken={...storage,async delete(){throw Error("Injected DELETE outage");}};await expect(reapSourceObjects(pool,broken)).rejects.toThrow("DELETE outage");expect(bodies.has(input.key)).toBe(true);
  await reapSourceObjects(pool,storage);expect(bodies.has(input.key)).toBe(false);expect((await pool.query("SELECT count(*) FROM agents_platform.source_objects WHERE object_key=$1",[input.key])).rows[0].count).toBe("1");
 });
 it("bounds lost-upload acknowledgement recovery to three immutable PUT attempts",async()=>{
  const owner=await platform.ensureAccount({issuer:"http://source/objects",subject:randomUUID(),email:"retry@example.test",displayName:"Retry owner"}),org=await platform.createOrganization(owner.id,"Retries"),scope={organizationId:org.id,accountId:owner.id};
  let attempts=0;const unknown=new KnowledgeStore(pool,{...storage,async put(key,bytes,type){attempts++;await storage.put(key,bytes,type);throw Error("Injected lost ACK");}}),input={operationId:randomUUID(),title:"Upload",contentType:"text/plain",content:Buffer.from("Immutable upload body"),parserRelease:"fixture-v1"};
  for(let count=0;count<3;count++)await expect(unknown.admitUpload(scope,input)).rejects.toThrow("lost ACK");await expect(unknown.admitUpload(scope,input)).rejects.toMatchObject({code:"SOURCE_WRITE_UNCERTAIN"});expect(attempts).toBe(3);
 });
});
