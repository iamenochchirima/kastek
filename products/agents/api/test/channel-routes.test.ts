import { randomBytes,randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { ChannelStore } from "../src/product/channels/channel-store";
import { TelegramSetupService } from "../src/product/channels/telegram-setup";
import { registerChannelRoutes } from "../src/product/channels/channel-routes";
import { ConnectionVault } from "../src/infrastructure/vault";
import { dropClosedTestDatabase } from "./support/database-cleanup";
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("customer channel HTTP authority",()=>{
  const database=`agents_channel_routes_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool;
  beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const isolated=new URL(url!);isolated.pathname=`/${database}`;pool=new Pool({connectionString:isolated.href});await setupPlatformSchema(pool);});
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  it("real routes encrypt bot credentials, require tenant authority and bind explicitly",async()=>{
    const platform=new PlatformStore(pool),owner=await platform.ensureAccount({issuer:"https://routes.example",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
    const organization=await platform.createOrganization(owner.id,"Channels"),scope={accountId:owner.id,organizationId:organization.id};
    const agent=await platform.createConfiguredAgent({...scope,name:"Support",offering:"faq"});
    const outsider=await platform.ensureAccount({issuer:"https://routes.example",subject:randomUUID(),email:"outsider@example.test",displayName:"Other"});
    const store=new ChannelStore(pool,new ConnectionVault("test",{test:randomBytes(32).toString("base64")}));let webhook="";const methods:string[]=[];
    const telegram=new TelegramSetupService(store,{callbackUrl:id=>`https://agents.example/api/telegram/${id}`,fetch:async(input,init)=>{
      const method=String(input).split("/").at(-1)!;methods.push(method);if(method==="setWebhook")webhook=JSON.parse(String(init?.body)).url;
      return Response.json({ok:true,result:method==="getMe"?{id:123,is_bot:true,first_name:"Help",username:"help_bot"}:method==="getWebhookInfo"?{url:webhook}:true});
    }});
    const app=Fastify();app.setErrorHandler((error,_req,reply)=>{const e=error as Error&{statusCode?:number;code?:string};reply.code(e.statusCode??400).send({error:{code:e.code,message:e.message}});});
    registerChannelRoutes(app,{store,telegram,resolveScope:async request=>({...scope,accountId:request.headers["x-outsider"]?outsider.id:owner.id}),resolveSessionId:async()=>"controlled-session-12345"});
    try{
      const base=`/api/organizations/${organization.id}/channels`;
      const created=await app.inject({method:"POST",url:`${base}/telegram/connect`,payload:{name:"Help",botToken:"123:controlled_secret"}});expect(created.statusCode).toBe(200);const connection=created.json().connection;expect(connection.state).toBe("active");expect(created.body).not.toContain("controlled_secret");
      const listed=await app.inject({method:"GET",url:base});expect(listed.statusCode).toBe(200);expect(listed.json().deployments).toEqual([]);expect(listed.body).not.toContain("controlled_secret");
      expect((await app.inject({method:"POST",url:`${base}/${connection.id}/bind`,payload:{expectedRevision:connection.revision,agentId:agent.agent.id}})).statusCode).toBe(200);
      const count=methods.length;expect((await app.inject({method:"POST",url:`${base}/telegram/connect`,headers:{"x-outsider":"yes"},payload:{name:"Forbidden",botToken:"999:secret"}})).statusCode).toBe(403);expect(methods).toHaveLength(count);
      expect((await app.inject({method:"POST",url:base,payload:{kind:"telegram",name:"Unsafe",mode:"bot",state:"active",credentials:{botToken:"raw"}}})).statusCode).toBe(400);
    }finally{await app.close();}
  });
});
