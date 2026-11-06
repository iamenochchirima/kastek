import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerChannelRoutes } from "../src/product/channels/channel-routes";

const ids={organization:"00000000-0000-4000-8000-000000000001",account:"00000000-0000-4000-8000-000000000002",
  agent:"00000000-0000-4000-8000-000000000003",connection:"00000000-0000-4000-8000-000000000004",
  deployment:"00000000-0000-4000-8000-000000000005",intent:"00000000-0000-4000-8000-000000000006",
  grant:"00000000-0000-4000-8000-000000000007"};

describe("Growth-managed channel activation ordering",()=>{
  it("installs the active Inbox binding before Growth transfers webhook ownership",async()=>{
    const events:string[]=[];
    const pool={connect:async()=>({query:async(sql:string)=>({rows:[],rowCount:sql.includes("memberships")?1:1}),release(){}})};
    const growthActor={issuer:"https://growth.example.test/identity",subject:"growth-owner"};
    const grant={grantId:ids.grant,state:"pending",routeOwner:"growth",provider:"facebook",connectionId:"growth-connection",
      providerAssetId:"page-1",permissionRevision:"revision-1",growthActor};
    const store={pool,
      async assertGrowthManagedAgent(){},
      async beginGrowthManaged(){return{id:ids.connection,revision:1,state:"pending"};},
      async growthLinkState(){return{requestId:ids.grant,exchangeRequestId:ids.deployment,agentId:ids.agent};},
      async completeGrowthManaged(){return{id:ids.connection,revision:2,state:"active"};},
      async bind(){events.push("bind");return{id:ids.deployment,state:"active"};},
      async recordGrowthManagedActor(){return{id:ids.connection,revision:3,state:"active"};},
      async markGrowthManagedNeedsAttention(){},
    };
    const growthLinks={async request(body:{operation:string;requestId:string;intentId?:string}){
      if(body.operation==="assets.list")return{operation:"assets.list",assets:[{connectionId:"growth-connection",providerAssetId:"page-1",provider:"facebook",name:"Test Page",growthOrganizationId:"growth-org",permissionRevision:"revision-1",providerMode:"meta"}]};
      if(body.operation==="grant.issue")return{operation:"grant.issue",intentId:body.intentId,code:"A".repeat(40)};
      if(body.operation==="grant.exchange")return{operation:"grant.exchange",grant};
      if(body.operation==="grant.activate"){
        events.push("activate");
        return{operation:"grant.activate",grant:{...grant,state:"active",routeOwner:"agents"}};
      }
      throw new Error(`Unexpected Growth operation ${body.operation}`);
    }};
    const app=Fastify();
    app.setErrorHandler((error,_request,reply)=>reply.code((error as Error&{statusCode?:number}).statusCode??500).send({error:(error as Error).message}));
    registerChannelRoutes(app,{store,growthLinks,resolveScope:async()=>({accountId:ids.account,organizationId:ids.organization}),
      resolveActor:async()=>({issuer:"https://agents.example.test/identity",subject:"owner"}),resolveSessionId:async()=>"session"} as never);
    try{
      const response=await app.inject({method:"POST",url:`/api/organizations/${ids.organization}/channels/growth/intents/${ids.intent}/select`,
        payload:{agentId:ids.agent,connectionId:"growth-connection",providerAssetId:"page-1"}});
      expect(response.statusCode).toBe(200);
      expect(events).toEqual(["bind","activate"]);
      expect(response.json().deployment).toMatchObject({id:ids.deployment,state:"active"});
    }finally{await app.close();}
  });
});
