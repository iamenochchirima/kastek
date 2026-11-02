import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {websiteAppearanceSchema} from "../src/adapters/channels/website/appearance";
import {WebsiteAppearanceStore} from "../src/product/deployments/appearance-store";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {dropClosedTestDatabase} from "./support/database-cleanup";

describe("recovered website appearance contract",()=>{
 it("fills recovered settings for existing deployments",()=>{
  expect(websiteAppearanceSchema.parse({title:"Support",accent:"#065f46"})).toMatchObject({title:"Support",accent:"#065f46",
   launcherSize:56,windowWidth:390,windowHeight:620,borderRadius:16,launcherOffset:16,showBranding:true,avatarUrl:""});
 });
 it.each([["launcherSize",44,96],["windowWidth",300,600],["windowHeight",360,800],["borderRadius",0,28],["launcherOffset",8,48]] as const)("validates %s against the recovered editor bounds",(field,min,max)=>{
  for(const value of [min,max])expect(websiteAppearanceSchema.safeParse({[field]:value}).success).toBe(true);
  for(const value of [min-1,max+1,min+.5,"50"])expect(websiteAppearanceSchema.safeParse({[field]:value}).success).toBe(false);
 });
 it("accepts image URLs without allowing executable or credential-bearing sources",()=>{
  for(const avatarUrl of ["","https://images.example/avatar.png","http://localhost:3007/avatar.png"])expect(websiteAppearanceSchema.safeParse({avatarUrl}).success).toBe(true);
  for(const avatarUrl of ["javascript:alert(1)","data:image/svg+xml,<svg/>","http://images.example/avatar.png","https://user:password@images.example/avatar.png","/avatar.png"])expect(websiteAppearanceSchema.safeParse({avatarUrl}).success).toBe(false);
 });
});

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("saved website appearance authority",()=>{
 const database=`agents_website_appearance_${randomUUID().replaceAll("-","")}`;
 let admin:Pool,pool:Pool,platform:PlatformStore,appearance:WebsiteAppearanceStore;
 beforeAll(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
  const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});
  await setupPlatformSchema(pool);platform=new PlatformStore(pool);appearance=new WebsiteAppearanceStore(pool);
 });
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 it("saves the full recovered settings with revision and current owner checks",async()=>{
  const account=await platform.ensureAccount({issuer:"https://appearance.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const org=await platform.createOrganization(account.id,"Website"),scope={accountId:account.id,organizationId:org.id};
  const agent=await platform.createConfiguredAgent({...scope,name:"Support",offering:"faq"});
  const deployment=await platform.publishCurrentWebsite({...scope,agentId:agent.agent.id,allowedOrigins:["example.com"]});
  const original=await appearance.get(scope,agent.agent.id,deployment.id);
  const settings={...original.appearance,accent:"#123456",avatarUrl:"https://images.example/avatar.png",windowWidth:540,windowHeight:760,
   launcherSize:72,launcherOffset:32,borderRadius:24,showBranding:false};
  const saved=await appearance.update(scope,agent.agent.id,deployment.id,{appearance:settings,paused:false,expectedAppearanceDigest:original.appearanceDigest});
  expect(saved.appearance).toEqual(settings);
  expect((await appearance.get(scope,agent.agent.id,deployment.id)).appearance).toEqual(settings);
  await expect(appearance.update(scope,agent.agent.id,deployment.id,{appearance:settings,paused:true,expectedAppearanceDigest:original.appearanceDigest})).rejects.toMatchObject({code:"WEBSITE_SETTINGS_CHANGED"});
  await pool.query("UPDATE agents_platform.memberships SET role='member' WHERE organization_id=$1 AND account_id=$2",[org.id,account.id]);
  await expect(appearance.update(scope,agent.agent.id,deployment.id,{appearance:settings,paused:true,expectedAppearanceDigest:saved.appearanceDigest})).rejects.toMatchObject({code:"ACCESS_DENIED"});
 });
});
