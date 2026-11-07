import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { exportPKCS8, exportSPKI, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { parseGrowthAgentAction, parseGrowthAgentCommand, parseGrowthAgentContext, parseGrowthDraftProposal } from "@kasitek-labs/contracts";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { GrowthAgentClient } from "../src/agents/client.js";
import { registerGrowthAgentRoutes } from "../src/agents/routes.js";
import { growthAgentDigest, verifyGrowthAgentAction } from "../src/agents/security.js";
import type { CoreContext } from "../src/context.js";
import { ApiError } from "../src/error.js";
const config = (env: Record<string, string> = {}) => readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent", ...env });
const actor = { issuer: "https://growth.kasitek.co.za/identity", subject: "user" };
const action = () => ({ version: "1", requestId: "request", operationId: "operation", tenantId: "org", actor, taskId: "task", conversationId: "conversation", featureId: "content", context: null, operation: "workspace.read", input: {} });
test("Growth synchronizes its current publication before direct resource calls and preserves native conflict details",async()=>{
  const keys=await generateKeyPair("RS256",{extractable:true}),privateKey=await exportPKCS8(keys.privateKey),operations:string[]=[];
  const settings=config({AGENTS_PRODUCT_API_URL:"https://agents.example.test",GROWTH_AGENTS_SIGNING_PRIVATE_KEY:privateKey});
  const client=new GrowthAgentClient(settings,{fetch:(async(_url,init)=>{
    const command=parseGrowthAgentCommand(JSON.parse(String(init?.body)));operations.push(command.operation);
    if(command.operation==="features.list"){
      assert.equal(command.input.publication?.manifest.revision,"15");assert.equal(command.input.publication?.policy.optionalCapabilities.knowledge,true);
      return Response.json({features:[],model:null});
    }
    assert.equal(command.operation,"resources.list");assert.deepEqual(command.actor,actor);return Response.json({featureId:"assistant",revision:1});
  }) as typeof fetch});
  await client.command({tenantId:"org",actor},"resources.list",{featureId:"assistant"},"first-resource-request");
  await client.command({tenantId:"org",actor},"resources.list",{featureId:"assistant"},"next-resource-request");
  assert.deepEqual(operations,["features.list","resources.list","resources.list"]);
  const conflict=new GrowthAgentClient(settings,{fetch:(async()=>Response.json({error:{code:"SOURCE_SCOPE_DENIED",message:"Select an approved source revision"}},{status:409})) as typeof fetch});
  await assert.rejects(conflict.command({tenantId:"org",actor},"tasks.list",{},"conflict"),error=>error instanceof ApiError&&error.code==="SOURCE_SCOPE_DENIED"&&error.message==="Select an approved source revision");
});
test("Growth contracts reject malformed context and hidden mutation authority", () => {
  assert.throws(() => parseGrowthAgentContext({ kind: "content_post" }));
  assert.throws(() => parseGrowthAgentContext({ kind: "workspace", grant: "all" }));
  assert.throws(() => parseGrowthAgentContext({ kind: "analytics_report", range: { from: "2030-02-01", to: "2030-01-01", timezone: "UTC" } }));
  assert.throws(() => parseGrowthDraftProposal({ title: "Title", content: "Content", channels: ["FACEBOOK"], channelSelections: {}, status: "PUBLISHED" }));
  assert.deepEqual(parseGrowthDraftProposal({ title: "Title", content: "Content", channels: [], channelSelections: {} }).channels, []);
  assert.throws(() => parseGrowthAgentCommand({ version: "1", requestId: "one", tenantId: "org", actor, operation: "tasks.cancel", input: {} }));
  assert.throws(() => parseGrowthAgentCommand({ version: "1", requestId: "one", tenantId: "org", actor, operation: "turns.submit", input: { conversationId: "one", text: "hello", actor: "other" } }));
  assert.throws(() => parseGrowthAgentAction({ ...action(), input: { sql: "SELECT *" } }));
  assert.throws(() => parseGrowthAgentAction({ ...action(), operation: "constructor" }));
});
test("Growth signing binds full scope and fixed audience, rejects changed body and excessive lifetime", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey), publicKey = await exportSPKI(keys.publicKey);
  const body = action(), conf = config({ AGENTS_PRODUCT_ACTION_PUBLIC_KEY: publicKey });
  const sign = (value: unknown, audience = "growth-agent-actions", lifetime = 60) => new SignJWT({ requestDigest: growthAgentDigest(value) })
    .setProtectedHeader({ alg: "RS256", kid: "agents-v1" }).setIssuer("https://agents.kasitek.co.za").setSubject("agents-worker")
    .setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + lifetime).setJti(randomUUID()).sign(keys.privateKey);
  const token = await sign(body);
  await verifyGrowthAgentAction(conf, `Bearer ${token}`, body);
  await assert.rejects(verifyGrowthAgentAction(conf, `Bearer ${token}`, { ...body, tenantId: "foreign" }), /unauthorized/);
  await assert.rejects(verifyGrowthAgentAction(conf, `Bearer ${await sign(body, "agents-product-api")}`, body), /unauthorized/);
  await assert.rejects(verifyGrowthAgentAction(conf, `Bearer ${await sign(body, "growth-agent-actions", 300)}`, body), /unauthorized/);
  const client = new GrowthAgentClient(config({ AGENTS_PRODUCT_API_URL: "https://agents.example.test", GROWTH_AGENTS_SIGNING_PRIVATE_KEY: privateKey }), {
    fetch: (async (url, init) => {
      assert.equal(url, "https://agents.example.test/internal/v1/products/growth/commands");
      const request = JSON.parse(String(init?.body)), bearer = (init?.headers as Record<string, string>).authorization.slice(7);
      const claims = await jwtVerify(bearer, keys.publicKey, { audience: "agents-product-api", issuer: "https://growth.kasitek.co.za", subject: "growth-api" });
      assert.equal(claims.payload.requestDigest, growthAgentDigest(request));
      assert.deepEqual(request.actor, actor); assert.equal(request.requestId, "stable-request");
      return Response.json({ tasks: [], nextCursor: null });
    }) as typeof fetch,
  });
  assert.deepEqual(await client.command({ tenantId: "org", actor }, "tasks.list", {}, "stable-request"), { tasks: [], nextCursor: null });
});
test("Growth browser bridge enforces origin and membership and reports truthful unavailability", async () => {
  let member = true;
  const core = { config: config(), pool: { query: async (sql: string) => ({ rows: !member ? [] : sql.includes('SELECT status,"failureCode"') ? [{ status: "pending", failureCode: null, updatedAt: new Date() }] : [{ name: "Business" }] }) } } as unknown as CoreContext;
  const app = await buildApp(core, [(app, core) => registerGrowthAgentRoutes(app, core, { resolveScope: async () => ({ tenantId: "org", actor }) })]);
  try {
    const bootstrap = await app.inject("/api/agents/bootstrap");
    assert.equal(bootstrap.statusCode, 200); assert.equal(bootstrap.json().features.length, 4);
    assert.equal(bootstrap.json().setup.state, "pending");
    assert.equal(bootstrap.json().features[0].reasons[0].message, "Setting up");
    assert.equal(bootstrap.json().features.every((feature: { ready: boolean }) => !feature.ready), true);
    assert.deepEqual(bootstrap.json().scope, { businessId: "org", userId: "user", businessName: "Business", canConfigureAgents:false });
    assert.equal((await app.inject({ method: "POST", url: "/api/agents/conversations", payload: { requestId: "one", featureId: "assistant" } })).statusCode, 403);
    member = false; assert.equal((await app.inject("/api/agents/bootstrap")).statusCode, 403);
  } finally { await app.close(); }
});
test("Growth exposes configured specialist metadata only to authorized managers",async()=>{
  const keys=await generateKeyPair("RS256",{extractable:true}),privateKey=await exportPKCS8(keys.privateKey);
  let role="MEMBER";
  const core={config:config({AGENTS_PRODUCT_API_URL:"https://agents.example.test",GROWTH_AGENTS_SIGNING_PRIVATE_KEY:privateKey}),pool:{query:async(sql:string)=>({rows:sql.includes('SELECT status,"failureCode"')?[{status:"ready",failureCode:null,updatedAt:new Date()}]:[{name:"Business",role}]})}} as unknown as CoreContext;
  const feature={id:"assistant",name:"Growth assistant",description:"",ready:true,reasons:[],memory:{enabled:false},specialists:[{id:"research",name:"Research",state:"disabled",memory:{enabled:true,availableToAssistant:false}}]};
  const app=await buildApp(core,[(app,context)=>registerGrowthAgentRoutes(app,context,{resolveScope:async()=>({tenantId:"org",actor}),fetch:(async()=>Response.json({features:[feature],model:null})) as typeof fetch})]);
  try{
    const member=await app.inject("/api/agents/bootstrap");assert.equal(member.statusCode,200);
    assert.equal(Object.hasOwn(member.json().features[0],"specialists"),false);
    role="OWNER";
    const owner=await app.inject("/api/agents/bootstrap");assert.equal(owner.statusCode,200);
    assert.deepEqual(owner.json().features[0].specialists,feature.specialists);
    assert.equal(owner.json().features[0].ready,true);
  }finally{await app.close();}
});
