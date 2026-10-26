import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { customerSetupSchema, customerConfigurationForSetup } from "../src/product/offerings/customer-setup";
import { PlatformStore } from "../src/product/agents/store";
import { customerSetupReadiness } from "../src/product/agents/setup-readiness";
import { setupPlatformSchema } from "../src/composition/setup";
import { dropClosedTestDatabase } from "./support/database-cleanup";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
const setup=()=>customerSetupSchema.parse({business:{name:"Business"},responsibilities:["bookings","enquiries"],channels:["website"],behaviour:{agentName:"Assistant",language:"English",tone:"professional",handoffInstructions:"Ask a person"}});
(databaseUrl?describe:describe.skip)("customer setup persistence",()=>{
 let admin:Pool,pool:Pool,store:PlatformStore;
 const database=`agents_setup_${randomUUID().replaceAll("-","")}`;
 beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){const account=await store.ensureAccount({issuer:"https://setup.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});const organization=await store.createOrganization(account.id,"Setup");return{accountId:account.id,organizationId:organization.id};}
 it("resumes the same draft after duplicate creation and persists setup progress",async()=>{
  const scope=await fixture(),operationId=randomUUID(),input=setup();
  const first=await store.createConfiguredAgent({...scope,name:"Assistant",setup:input,operationId});
  const duplicate=await store.createConfiguredAgent({...scope,name:"Assistant",setup:input,operationId});
  expect(duplicate.agent.id).toBe(first.agent.id);expect(await store.listVersions(scope.accountId,scope.organizationId,first.agent.id)).toHaveLength(1);
  await expect(store.createConfiguredAgent({...scope,name:"Changed",setup:input,operationId})).rejects.toMatchObject({code:"SETUP_OPERATION_CONFLICT"});
  const saved=await store.saveConfiguration({...scope,agentId:first.agent.id,expectedRevision:1,configuration:first.agent.draft,setup:input,setupStep:"Bookings"});
  expect(saved.agent.setup_step).toBe("Bookings");
  const readiness=await customerSetupReadiness(pool,scope.accountId,scope.organizationId,first.agent.id);
  expect(readiness.readyToTest).toBe(false);expect(readiness.requirements.bookings).toEqual({state:"needs_setup",code:"BOOKING_POLICY_REQUIRED"});
  expect(readiness.requirements.enquiries.state).toBe("ready");expect(readiness.channels).toEqual([{kind:"website",state:"needs_connection"}]);
  const other=await fixture();await expect(customerSetupReadiness(pool,other.accountId,scope.organizationId,first.agent.id)).rejects.toMatchObject({code:"ACCESS_DENIED"});
 });
 it("saves setup alongside configuration and snapshots, retaining it through knowledge updates",async()=>{
  const scope=await fixture(),input=setup(),created=await store.createConfiguredAgent({...scope,name:"Assistant",setup:input});
  expect(created.agent.setup).toEqual(input);expect(created.agent.offering).toBe("customer-service");
  expect(created.snapshot.configuration).toEqual(created.agent.draft);
  expect(created.agent.draft.capabilities.businessActions.enabled).toBe(false);
  const changed={...input,channels:["telegram" as const],behaviour:{...input.behaviour,language:"French"}};
  const saved=await store.saveConfiguration({...scope,agentId:created.agent.id,expectedRevision:1,configuration:created.agent.draft,setup:changed});
  expect(saved.agent.setup).toEqual(changed);expect(saved.snapshot.number).toBe(2);
  expect(saved.agent.draft.instructions).toContain("French");
  expect(saved.agent.draft.tools).toEqual(created.agent.draft.tools);
  const next=await store.saveConfiguration({...scope,agentId:created.agent.id,expectedRevision:saved.agent.draft_revision,configuration:{...saved.agent.draft,instructions:saved.agent.draft.instructions+"\nAdditional approved context."}});
  expect(next.agent.setup).toEqual(changed);
  await expect(store.saveConfiguration({...scope,agentId:created.agent.id,expectedRevision:1,configuration:created.agent.draft,setup:input})).rejects.toMatchObject({code:"DRAFT_CONFLICT"});
  expect((await store.getAgent(scope.accountId,scope.organizationId,created.agent.id)).setup).toEqual(changed);
 });
 it("rejects cross-workspace edits and rolls setup back when publication fails",async()=>{
  const scope=await fixture(),created=await store.createConfiguredAgent({...scope,name:"Assistant",setup:setup()}),other=await fixture();
  await expect(store.saveConfiguration({...other,agentId:created.agent.id,expectedRevision:1,configuration:created.agent.draft,setup:setup()})).rejects.toMatchObject({code:"NOT_FOUND"});
  const changed={...setup(),business:{...setup().business,name:"Changed"}};
  const config=customerConfigurationForSetup(changed);config.sourceRevisionIds=[randomUUID()];
  await expect(store.saveConfiguration({...scope,agentId:created.agent.id,expectedRevision:1,configuration:config,setup:changed,confirmImpact:true})).rejects.toMatchObject({code:"SOURCE_REVISION_UNAVAILABLE"});
  expect((await store.getAgent(scope.accountId,scope.organizationId,created.agent.id)).setup).toEqual(setup());
  expect(await store.listVersions(scope.accountId,scope.organizationId,created.agent.id)).toHaveLength(1);
 });
});
