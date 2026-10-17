import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPlatformApp } from "../src/platform/app";
import { loadPlatformConfig } from "../src/platform/config";
import { PlatformStore } from "../src/platform/store";
import { setupPlatformSchema } from "../src/platform/setup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("Optional runtime service HTTP wiring",()=>{
  let admin:Pool,pool:Pool,app:Awaited<ReturnType<typeof buildPlatformApp>>,store:PlatformStore;
  const database=`agents_runtime_wiring_${randomUUID().replaceAll("-","")}`;
  beforeAll(async()=>{
    // An ordinary FAQ deployment need not configure connected-tool credentials or object storage.
    for(const key of Object.keys(process.env))if(key.startsWith("AGENTS_CONNECTION_")||key.startsWith("AGENTS_S3_")||key==="AGENTS_DOCUMENT_RUNTIME_ENABLED")vi.stubEnv(key,"");
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:url.href,
      AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"offline-runtime-wiring-test-only",OPENROUTER_API_KEY:"offline-fixture-never-sent"})});
    store=new PlatformStore(pool);
  });
  afterAll(async()=>{await app?.close();await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();}vi.unstubAllEnvs();});
  async function actor(){
    const user=await store.ensureAccount({issuer:"http://localhost:8080/realms/kasitek",subject:randomUUID(),email:"runtime@example.com",displayName:"Runtime"});
    const session=await store.createSession({accountId:user.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+60_000)});
    const cookie=`agents_session=${session.token}`;
    const created=await app.inject({method:"POST",url:"/api/organizations",headers:{cookie,origin:"http://localhost:3100"},payload:{name:"Runtime"}});
    expect(created.statusCode).toBe(201);return{user,cookie,organizationId:created.json().organization.id};
  }
  it("authorizes cited-source inspection separately from unavailable backend metadata",async()=>{
    const owner=await actor(),other=await actor(),base=`/api/organizations/${owner.organizationId}`;
    const headers={cookie:owner.cookie,origin:"http://localhost:3100"};
    const agent=(await app.inject({method:"POST",url:`${base}/agents`,headers,payload:{name:"FAQ"}})).json().agent;
    const version=(await app.inject({method:"POST",url:`${base}/agents/${agent.id}/versions`,headers,payload:{expectedRevision:1}})).json().version;
    const admitted=await app.inject({method:"POST",url:`${base}/tasks`,headers,payload:{versionId:version.id,requestKey:randomUUID(),input:"Question"}});
    expect(admitted.statusCode).toBe(202);const taskId=admitted.json().task.id,url=`${base}/tasks/${taskId}/evidence`;
    expect((await app.inject({url})).statusCode).toBe(401);
    expect((await app.inject({url,headers:{cookie:other.cookie}})).statusCode).toBe(403);
    expect((await app.inject({url,headers})).json()).toEqual({state:"available",passages:[]});
    await pool.query("UPDATE agents_platform.tasks SET output=$2 WHERE id=$1",[taskId,`Unverified citation [E${"a".repeat(32)}]`]);
    expect((await app.inject({url,headers})).json()).toEqual({state:"unavailable",code:"EVIDENCE_BACKEND_UNAVAILABLE",passages:[]});
  });
  it("returns explicit disabled metadata without credentials, after authenticating current membership",async()=>{
    const owner=await actor(),other=await actor();
    for(const endpoint of ["connections","tool-bindings"]){
      const url=`/api/organizations/${owner.organizationId}/${endpoint}`;
      expect((await app.inject({url})).statusCode).toBe(401);
      expect((await app.inject({url,headers:{cookie:other.cookie}})).statusCode).toBe(403);
      const response=await app.inject({url,headers:{cookie:owner.cookie}});expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(endpoint==="connections"?{connections:[],targets:[],profiles:[],available:false}:{bindings:[],available:false});
    }
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE account_id=$1 AND organization_id=$2",[owner.user.id,owner.organizationId]);
    expect((await app.inject({url:`/api/organizations/${owner.organizationId}/tool-bindings`,headers:{cookie:owner.cookie}})).statusCode).toBe(403);
  });
});
