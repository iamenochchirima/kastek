import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("catalogues through authenticated application API",()=>{
  const database=`agents_catalogue_${randomUUID().replaceAll("-","")}`,origin="http://localhost:3100";
  let admin:Pool,pool:Pool,store:PlatformStore,app:Awaited<ReturnType<typeof buildPlatformApp>>;
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:url.href,
      AGENTS_PUBLIC_URL:origin,AGENTS_OIDC_CLIENT_SECRET:"catalogue-fixture-secret-only-32-characters"})});
  });
  afterAll(async()=>{await app?.close();await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  it("discovers reviewed catalogue skills, installs a real revision and publishes an explicitly selected skill",async()=>{
    const owner=await store.ensureAccount({issuer:"http://localhost:8080/realms/kasitek",subject:randomUUID(),email:"test@example.test",displayName:"Owner"});
    const organization=await store.createOrganization(owner.id,"Catalogue HTTP"),agent=await store.createAgent({accountId:owner.id,organizationId:organization.id,name:"Support"});
    const session=await store.createSession({accountId:owner.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60000)});
    const headers={cookie:`agents_session=${session.token}`,origin},base=`/api/organizations/${organization.id}`,agentPath=`${base}/agents/${agent.id}`;
    expect((await app.inject({url:`${base}/catalogue/tools?agentId=${agent.id}`})).statusCode).toBe(401);
    const response=await app.inject({url:`${base}/catalogue/skills?agentId=${agent.id}`,headers});expect(response.statusCode).toBe(200);
    const catalogue=response.json();expect(catalogue.entries).toHaveLength(2);expect(catalogue.entries.every((entry:any)=>entry.publisher.verified)).toBe(true);
    const selected=catalogue.entries.find((entry:any)=>entry.source.slug==="grounded-answers");expect(selected.configuration.skillIds).toEqual([]);
    const install=await app.inject({method:"POST",url:`${agentPath}/skills/curated/grounded-answers/install`,headers,payload:{operationId:randomUUID()}});
    expect(install.statusCode).toBe(200);const installed=install.json().package;expect(installed.reviewState).toBe("reviewed");
    const refreshed=(await app.inject({url:`${base}/catalogue/skills?agentId=${agent.id}`,headers})).json();
    expect(refreshed.entries.find((entry:any)=>entry.source.slug==="grounded-answers").configuration.skillIds).toEqual([installed.id]);
    const before=await store.getAgent(owner.id,organization.id,agent.id);expect(before.draft.skillIds).toEqual([]);
    const update=await app.inject({method:"PUT",url:agentPath,headers,payload:{configuration:{...before.draft,skillIds:[installed.id]},expectedRevision:before.draft_revision}});
    expect(update.statusCode).toBe(200);
    const published=await app.inject({method:"POST",url:`${agentPath}/versions`,headers,payload:{expectedRevision:update.json().agent.draftRevision}});
    expect(published.statusCode,published.body).toBe(201);expect(published.json().version.configuration.skillIds).toEqual([installed.id]);
    expect((await app.inject({url:`${base}/catalogue/tools?agentId=${randomUUID()}`,headers})).statusCode).toBe(404);
  });
});
