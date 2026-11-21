import {dropClosedTestDatabase} from "./support/database-cleanup";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {KnowledgeStore} from "../src/platform/knowledge/knowledge";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {textDigest} from "../src/contracts/source-contracts";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("candidate revision privacy across different importers",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,knowledge:KnowledgeStore;
 const database=`agents_candidate_${randomUUID().replaceAll("-","")}`,bodies=new Map<string,Uint8Array>();let beforeRead:(()=>Promise<void>)|undefined;
 beforeAll(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
  knowledge=new KnowledgeStore(pool,{async put(key,bytes){bodies.set(key,bytes);},async get(key){await beforeRead?.();const bytes=bodies.get(key);if(!bytes)throw Error("Missing private fixture content");return bytes;},async delete(key){bodies.delete(key);}});
 });
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){
  const owner=await platform.ensureAccount({issuer:"http://candidate/privacy",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const original=await platform.ensureAccount({issuer:"http://candidate/privacy",subject:randomUUID(),email:"member@example.test",displayName:"Original importer"});
  const org=await platform.createOrganization(owner.id,"Candidate privacy");await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[org.id,original.id]);
  const ownerScope={organizationId:org.id,accountId:owner.id},originalScope={organizationId:org.id,accountId:original.id};
  const first=await knowledge.admitUpload(originalScope,{operationId:randomUUID(),title:"Member source",contentType:"text/plain",content:Buffer.from("Original private candidate"),parserRelease:"fixture-parser-v1"});
  await seal(first,"Original private candidate");
  const refreshed=await knowledge.admitUpload(ownerScope,{operationId:randomUUID(),sourceId:first.sourceId,title:"Owner refresh",contentType:"text/plain",content:Buffer.from("Owner-only private refresh"),parserRelease:"fixture-parser-v1"});await seal(refreshed,"Owner-only private refresh");
  return{ownerScope,originalScope,first,refreshed};
 }
 async function seal(job:{id:string;revisionId:string},text:string){
  await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);
  await knowledge.publishExtraction(job.id,{text,normalizerRelease:"fixture-v1",acquiredAt:new Date().toISOString(),chunks:[{id:randomUUID(),revisionId:job.revisionId,ordinal:0,start:0,end:text.length,page:1,section:null,text,digest:textDigest(text),tokens:8}]});
 }
 it("shows each candidate only to its actual importing account and current owners",async()=>{
  const f=await fixture();expect((await knowledge.list(f.originalScope))[0]!.revisions.map(revision=>revision.id)).toEqual([f.first.revisionId]);
  expect((await knowledge.list(f.ownerScope))[0]!.revisions.map(revision=>revision.id)).toEqual([f.first.revisionId,f.refreshed.revisionId]);
  expect((await knowledge.preview(f.originalScope,f.first.sourceId,f.first.revisionId)).text).toBe("Original private candidate");
  expect((await knowledge.preview(f.ownerScope,f.first.sourceId,f.refreshed.revisionId)).text).toBe("Owner-only private refresh");
  await expect(knowledge.preview(f.originalScope,f.first.sourceId,f.refreshed.revisionId)).rejects.toMatchObject({code:"SOURCE_NOT_FOUND"});
 });
 it("does not turn revision approval into broad management preview permission",async()=>{
  const f=await fixture();await knowledge.setPolicy(f.ownerScope,f.first.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"approve",revisionId:f.refreshed.revisionId});
  await expect(knowledge.preview(f.originalScope,f.first.sourceId,f.refreshed.revisionId)).rejects.toMatchObject({code:"SOURCE_NOT_FOUND"});
  await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.ownerScope.organizationId,f.ownerScope.accountId]);
  await expect(knowledge.preview(f.ownerScope,f.first.sourceId,f.refreshed.revisionId)).rejects.toMatchObject({code:"ACCESS_DENIED"});
 });
 it("rechecks candidate importer or current owner after a delayed private object read",async()=>{
  const f=await fixture();await pool.query("UPDATE agents_platform.memberships SET role='owner' WHERE organization_id=$1 AND account_id=$2",[f.originalScope.organizationId,f.originalScope.accountId]);
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(done=>entered=done),barrier=new Promise<void>(done=>release=done);beforeRead=async()=>{entered();await barrier;};
  const preview=knowledge.preview(f.originalScope,f.first.sourceId,f.refreshed.revisionId);const denied=expect(preview).rejects.toMatchObject({code:"SOURCE_NOT_FOUND"});await started;
  await pool.query("UPDATE agents_platform.memberships SET role='member' WHERE organization_id=$1 AND account_id=$2",[f.originalScope.organizationId,f.originalScope.accountId]);release();await denied;beforeRead=undefined;
 });
});
