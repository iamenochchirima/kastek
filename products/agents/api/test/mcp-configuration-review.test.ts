import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { ConfigurationReview } from "../src/product/mcp/configuration-review";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("MCP configuration review",()=>{
 let admin:Pool,pool:Pool;
 const dbname=`agents_config_review_${randomUUID().replaceAll("-","")}`;
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${dbname}"`);const u=new URL(url!);u.pathname=`/${dbname}`;pool=new Pool({connectionString:u.href});await setupPlatformSchema(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,dbname);await admin.end();}});
 it("pins the exact change, requires the signed-in owner, and applies it once",async()=>{
  const store=new PlatformStore(pool),user=await store.ensureAccount({issuer:"https://fixture.example",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const org=await store.createOrganization(user.id,"Review"),config=defaultBusinessConfiguration();
  const agent=await store.createAgent({accountId:user.id,organizationId:org.id,name:"FAQ",configuration:config});
  await store.createVersion({accountId:user.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
  const connectionId=randomUUID(),clientId=randomUUID();
  await pool.query("INSERT INTO agents_platform.mcp_oauth_clients(id,name,redirect_uris,registration_hash) VALUES($1,'Test',ARRAY['https://example.test/callback'],'x')",[clientId]);
  await pool.query("INSERT INTO agents_platform.mcp_oauth_connections(id,client_id,account_id,organization_id,resource,scopes,access_hash,access_expires_at) VALUES($1,$2,$3,$4,'https://example.test/mcp',ARRAY['agents:manage'],'token',now()+interval '1 hour')",[connectionId,clientId,user.id,org.id]);
  const review=new ConfigurationReview(pool,"https://agents.example",async()=>{}),scope={accountId:user.id,organizationId:org.id,connectionId};
  await expect(review.propose(scope,{agentId:agent.id,requestId:randomUUID(),expectedRevision:1,configuration:{...config,connectedToolBindingIds:[randomUUID()]}}))
    .rejects.toMatchObject({code:"REVIEW_REFERENCE_UNAVAILABLE"});
  const other=await store.createAgent({accountId:user.id,organizationId:org.id,name:"Other",configuration:config});
  const skillA=randomUUID(),skillB=randomUUID();
  for(const [skillId,agentId] of [[skillA,agent.id],[skillB,other.id]])await pool.query(`INSERT INTO agents_platform.skill_revisions
    (id,organization_id,agent_id,created_by,name,description,body,revision,content_digest,operation_id,request_digest)
    VALUES($1,$2,$3,$4,'Matching skill','','text',1,'digest',$5,'digest')`,[skillId,org.id,agentId,user.id,randomUUID()]);
  await expect(review.propose(scope,{agentId:agent.id,requestId:randomUUID(),expectedRevision:1,configuration:{...config,skillIds:[skillA,skillB]}}))
    .rejects.toMatchObject({code:"REVIEW_REFERENCE_AMBIGUOUS"});
  const input={agentId:agent.id,requestId:randomUUID(),expectedRevision:1,configuration:{...config,tools:["knowledge.search"]}};
  const proposal=await review.propose(scope,input);expect(proposal.state).toBe("pending");expect(proposal.changes).toEqual(expect.arrayContaining([expect.objectContaining({field:"tools",after:expect.stringContaining("Knowledge")})]));
  expect((await review.propose(scope,input)).id).toBe(proposal.id);
  await expect(review.decide(randomUUID(),proposal.id,true)).rejects.toMatchObject({code:"NOT_FOUND"});
  const approved=await review.decide(user.id,proposal.id,true);expect(approved).toMatchObject({state:"approved",resultingRevision:2});
  expect(await review.decide(user.id,proposal.id,true)).toMatchObject({state:"approved",resultingRevision:2});
  expect((await store.getAgent(user.id,org.id,agent.id)).draft.tools).toContain("knowledge.search");
  const stale=await review.propose(scope,{...input,requestId:randomUUID(),expectedRevision:2,configuration:{...config,tools:["knowledge.read"]}});
  await store.saveConfiguration({accountId:user.id,organizationId:org.id,agentId:agent.id,configuration:config,expectedRevision:2,confirmImpact:true});
  await expect(review.decide(user.id,stale.id,true)).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
  expect((await review.get(user.id,stale.id)).state).toBe("pending");
 });
});
