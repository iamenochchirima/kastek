import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { beginOperation } from "../src/execution/lifecycle/execution";
import { PlatformStore } from "../src/product/agents/store";
import { PrivatePreview } from "../src/product/agents/private-preview";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("private preview database admission",()=>{
  let admin:Pool,pool:Pool;
  const dbname=`agents_preview_${randomUUID().replaceAll("-","")}`;
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});
    await admin.query(`CREATE DATABASE "${dbname}"`);
    const testUrl=new URL(url!);testUrl.pathname=`/${dbname}`;
    pool=new Pool({connectionString:testUrl.href});await setupPlatformSchema(pool);
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,dbname);await admin.end();}});
  it("pins retries to the original snapshot and denies effects before operation admission",async()=>{
    const store=new PlatformStore(pool), user=await store.ensureAccount({issuer:"https://fixture.example",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
    const org=await store.createOrganization(user.id,"Preview");
    await connectFixtureModel(pool,user.id,org.id,"fixture/model-a");
    const cfg=defaultBusinessConfiguration(),agent=await store.createAgent({accountId:user.id,organizationId:org.id,name:"FAQ",configuration:cfg});
    const firstVersion=await store.createVersion({accountId:user.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
    const preview=new PrivatePreview(pool,async()=>{}),scope={accountId:user.id,organizationId:org.id};
    const input={agentId:agent.id,message:"What are your hours?",requestId:randomUUID()};
    const first=await preview.start(scope,input);
    const saved=(await pool.query("SELECT version_id,execution_purpose FROM agents_platform.tasks WHERE id=$1",[first.id])).rows[0];
    expect(saved).toMatchObject({version_id:firstVersion.id,execution_purpose:"private_preview_v1"});
    await store.updateDraft({accountId:user.id,organizationId:org.id,agentId:agent.id,expectedRevision:1,configuration:cfg});
    await store.createVersion({accountId:user.id,organizationId:org.id,agentId:agent.id,expectedRevision:2});
    expect(await preview.start(scope,input)).toMatchObject({id:first.id,replayed:true});
    await expect(preview.start(scope,{...input,message:"Something else"})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    await expect(beginOperation(pool,first.id,{id:randomUUID(),kind:"tool",name:"booking.execute",request:{},reservedTokens:0,reservedMs:1000})).rejects.toMatchObject({code:"PREVIEW_ACTION_UNAVAILABLE"});
    expect((await pool.query("SELECT count(*) FROM agents_platform.operations WHERE task_id=$1",[first.id])).rows[0].count).toBe("0");
    await expect(pool.query("UPDATE agents_platform.tasks SET execution_purpose='business_v1' WHERE id=$1",[first.id])).rejects.toMatchObject({code:"23514"});
    await pool.query("UPDATE agents_platform.tasks SET state='completed',output=$2 WHERE id=$1",[first.id,"We open at nine."]);
    expect(await preview.get(scope,{taskId:first.id})).toMatchObject({state:"completed",output:"We open at nine."});
    await expect(preview.get({accountId:randomUUID(),organizationId:org.id},{taskId:first.id})).rejects.toMatchObject({code:"NOT_FOUND"});
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[org.id,user.id]);
    await expect(preview.get(scope,{taskId:first.id})).rejects.toMatchObject({code:"NOT_FOUND"});
  });
});
