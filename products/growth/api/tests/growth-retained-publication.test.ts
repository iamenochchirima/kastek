import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import pg from "pg";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { readConfig } from "../src/config.js";
import { installErrorHandler } from "../src/error.js";
import { registerGrowthCapabilityRoutes } from "../src/agents/capability-routes.js";
import { growthAgentDigest } from "../src/agents/security.js";
import { growthAgentPublicationV11 } from "../src/agents/retained-publication-v11.js";
import { growthAgentPublicationV11Local } from "../src/agents/retained-publication-v11-local.js";

test("both source-frozen V11 catalogues authorize exact retained Facebook read bindings", {skip:!process.env.CORE_ORGS_TEST_DATABASE_URL}, async()=>{
  const url=process.env.CORE_ORGS_TEST_DATABASE_URL!,schema="growth_retained_"+randomUUID().replaceAll("-","");
  const admin=new pg.Pool({connectionString:url});await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const app=Fastify();installErrorHandler(app);
  const previous=process.env.KASITEK_BILLING_ENFORCEMENT;process.env.KASITEK_BILLING_ENFORCEMENT="false";
  try{
    await pool.query(`CREATE TABLE "Organization"(id text,name text);CREATE TABLE "User"(id text,"emailVerified" timestamp);CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);INSERT INTO "Organization" VALUES('org','Business');INSERT INTO "User" VALUES('user',now());INSERT INTO "OrganizationMember" VALUES('org','user','OWNER')`);
    const keys=await generateKeyPair("RS256",{extractable:true});
    registerGrowthCapabilityRoutes(app,{pool,config:readConfig({DATABASE_URL:url,AGENTS_PRODUCT_ACTION_PUBLIC_KEY:await exportSPKI(keys.publicKey)})});
    const send=async(body:unknown)=>{
      const token=await new SignJWT({product:"growth",requestDigest:growthAgentDigest(body)}).setProtectedHeader({alg:"RS256",kid:"agents-v1"})
        .setIssuer("https://agents.kasitek.co.za").setAudience("product-capability-actions").setSubject("agents-worker").setJti(randomUUID()).setIssuedAt().setExpirationTime("60s").sign(keys.privateKey);
      return app.inject({method:"POST",url:"/internal/agents/capabilities",headers:{authorization:"Bearer "+token},payload:body});
    };
    assert.equal(growthAgentPublicationV11Local.manifest.digest,"9578a1719764af11b1ceadb391503fcaa5ec75d3be311bd812d0ace867114060");
    assert.equal(growthAgentPublicationV11Local.manifest.adapter.manifestDigest,"ea866f17fc8f723774d916468055fda67ebd30851a1b18821fc6aebbfcdf06fa");
    const {digest,...manifestBody}=growthAgentPublicationV11Local.manifest;
    assert.equal(growthAgentDigest(manifestBody),digest);
    const statuses:number[]=[],commands:Record<string,unknown>[]=[];
    for(const publication of [growthAgentPublicationV11,growthAgentPublicationV11Local])for(const operation of ["connections.list","content.accounts.list"]){
      const descriptor=publication.manifest.operations.find(value=>value.operation===operation)!;
      const command={version:"1",requestId:randomUUID(),operationId:"retained-read",taskId:randomUUID(),conversationId:randomUUID(),
        actor:{issuer:"https://growth.kasitek.co.za/identity",subject:"user"},bindingId:randomUUID(),bindingDigest:"a".repeat(64),operation,control:"authorize",input:{},
        authority:{kind:"product",originProduct:"growth",destinationProduct:"growth",originTenantId:"org",tenantId:"org",mappingRef:"growth:org",policyRevision:"11",
          manifestDigest:publication.manifest.digest,descriptorDigest:growthAgentDigest(descriptor),handlerRef:descriptor.handlerRef}};
      const response=await send(command);statuses.push(response.statusCode);commands.push(command);
    }
    assert.deepEqual(statuses,[200,200,200,200]);
    const local=commands[2]! as {authority:Record<string,unknown>};
    const hostedOnly=growthAgentPublicationV11.manifest.operations.find(value=>!growthAgentPublicationV11Local.manifest.operations.some(local=>local.operation===value.operation))!;
    assert.equal((await send({...local,operation:hostedOnly.operation,authority:{...local.authority,descriptorDigest:growthAgentDigest(hostedOnly),handlerRef:hostedOnly.handlerRef}})).statusCode,403);
    assert.equal((await send({...local,authority:{...local.authority,descriptorDigest:"0".repeat(64)}})).statusCode,403);
    assert.equal((await send({...local,authority:{...local.authority,policyRevision:"12"}})).statusCode,403);
    await pool.query('DELETE FROM "OrganizationMember"');
    assert.equal((await send(local)).statusCode,403);
  }finally{if(previous===undefined)delete process.env.KASITEK_BILLING_ENFORCEMENT;else process.env.KASITEK_BILLING_ENFORCEMENT=previous;await app.close();await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
