import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import pg from "pg";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import { claimPublishJob, executeSocialPublishJob } from "../src/services/social/publishing.js";
import { executeGrowthOperation } from "../src/operations/reviews.js";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ProductCapabilityInvocation } from "@kasitek-labs/contracts";
import { installPgTimestampParsers } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { readConfig } from "../src/config.js";
import { oauthDigest, resolveGrowthOAuthContext, registerGrowthOAuthRoutes } from "../src/oauth/index.js";
import { registerGrowthOperationRoutes } from "../src/operations/routes.js";
import { registerGrowthMcpRoutes } from "../src/operations/mcp.js";
import { registerGrowthMediaTransferRoutes } from "../src/operations/media-transfers.js";
import { invokeInternalGrowthOperation } from "../src/operations/internal.js";
import { growthOperationDescriptors } from "../src/operations/manifest.js";
import { registerGrowthCapabilityRoutes } from "../src/agents/capability-routes.js";
import { growthAgentPublication } from "../src/agents/manifest.js";
import { growthAgentDigest, growthAgentActor } from "../src/agents/security.js";
import { registerPublicV1Routes } from "../src/routes/public-v1.js";
import type { PublicDomainAdapter } from "../src/services/public-api.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";

const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("real OAuth, SDK MCP, REST aliases and internal operations share contracts, exact reviews and revocation", { skip: !database, timeout: 60000 }, async () => {
  installPgTimestampParsers();
  const inventory=new pg.Pool({connectionString:database});
  const fixtureTables=(await inventory.query<{tablename:string}>(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map(row=>row.tablename).filter(name=>/^[A-Za-z_]+$/.test(name)&&!["GrowthOperationReview","GrowthMediaTransfer"].includes(name)&&!name.startsWith("GrowthOAuth")&&name!=="analytics_outbox");
  await inventory.end();
  const fixture = await isolatedDatabase(database!, "growth_access",fixtureTables);
  const { pool } = fixture;
  const mediaDirectory = await mkdtemp(join(tmpdir(), "growth-agent-access-"));
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const clients: Client[] = [];
  try {
    await pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql", import.meta.url), "utf8"));
    for (const migration of ["20261101130000_growth_oauth.sql", "20261101140000_growth_operation_reviews.sql", "20261101150000_growth_media_transfers.sql", "20261102190000_content_agent_workflows.sql"])
      await pool.query(await readFile(new URL(`../sql/${migration}`, import.meta.url), "utf8"));
    await pool.query(`INSERT INTO "User"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('alice','Alice','alice@example.test',NOW(),NOW(),NOW());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org-a','Fixture business','fixture-business','alice',NOW(),NOW());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org-a','alice','OWNER',NOW());
      INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","updatedAt") VALUES('facebook','alice','org-a','FACEBOOK','CONNECTED','Fixture page','fixture-page',NOW());`);
    await pool.query(`INSERT INTO "Session"(id,"sessionToken","userId","refreshToken","idToken",expires,"identityCheckedAt","providerRefreshedAt","lastActivityAt") VALUES('session',$1,'alice','unused','unused',NOW()+interval '1 day',NOW(),NOW(),NOW())`, [oauthDigest("alice-session")]);
    const listener = createServer();
    await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
    const port = (listener.address() as {port:number}).port;
    await new Promise<void>((resolve,reject) => listener.close(error => error ? reject(error) : resolve()));
    const keys = await generateKeyPair("RS256");
    const config = readConfig({ DATABASE_URL: database!, ENVIRONMENT: "test", FRONTEND_URL: "http://localhost:3002", KASITEK_CORE_PUBLIC_URL: `http://127.0.0.1:${port}`, LOG_LEVEL: "silent", GROWTH_AGENT_ACCESS_ENABLED: "true", GROWTH_AGENT_EFFECTS_ENABLED: "true", SOCIAL_TOKEN_ENCRYPTION_KEY:"isolated-http-publication-fixture", KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE:"1000", KASITEK_MEDIA_STORAGE_PATH: mediaDirectory, AGENTS_PRODUCT_ACTION_PUBLIC_KEY: await exportSPKI(keys.publicKey) });
    const core = { pool, config };
    await pool.query(`UPDATE "SocialChannelConnection" SET "accessToken"=$1,metadata=$2 WHERE id='facebook'`,[encryptSocialSecret(config,"synthetic-provider-token"),JSON.stringify({permissionsInspected:true,scope:"pages_manage_posts",tasks:["CREATE_CONTENT"]})]);

    app = await buildApp(core, [registerGrowthOAuthRoutes, registerGrowthOperationRoutes, registerGrowthMcpRoutes, registerGrowthMediaTransferRoutes, registerGrowthCapabilityRoutes,
      (server, context) => registerPublicV1Routes(server, context, {} as PublicDomainAdapter)]);
    const base = await app.listen({ host: "127.0.0.1", port });
    const human = { cookie: "kasitek_session=alice-session; kasitek_active_org=org-a", origin: config.frontendUrl };
    const request = async (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST") => {
      const response = await fetch(`${base}${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual" });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
    };
    const registration = await request("/oauth/register", { client_name: "Real SDK fixture", redirect_uris: ["http://127.0.0.1:8787/callback"] });
    assert.equal(registration.status, 201, JSON.stringify(registration.body));
    const clientId = registration.body.client_id;
    async function issue(scope = "growth:read growth:draft growth:publish growth:manage") {
      const verifier = randomBytes(32).toString("base64url");
      const query = new URLSearchParams({ client_id: clientId, resource: `${base}/mcp`, redirect_uri: "http://127.0.0.1:8787/callback", scope, state: "fixture-state", response_type: "code", code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" });
      const authorization = await request(`/oauth/authorize?${query}`);
      assert.equal(authorization.status, 302, JSON.stringify(authorization.body));
      const nonce = new URL(authorization.headers.get("location")!).searchParams.get("request")!;
      assert.equal((await request(`/api/oauth/requests/${nonce}`, undefined, human)).status, 200);
      const decision = await request(`/api/oauth/requests/${nonce}/decision`, { approved: true, organizationId: "org-a" }, human);
      assert.equal(decision.status, 200, JSON.stringify(decision.body));
      const callback = new URL(decision.body.redirectUrl);
      assert.equal(callback.searchParams.get("state"), "fixture-state");
      const exchange = await request("/oauth/token", { grant_type: "authorization_code", client_id: clientId, resource: `${base}/mcp`, code: callback.searchParams.get("code"), redirect_uri: "http://127.0.0.1:8787/callback", code_verifier: verifier });
      assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
      return exchange.body as { access_token: string; refresh_token: string };
    }
    let sdkRegistration:OAuthClientInformationMixed|undefined,sdkTokens:OAuthTokens|undefined,sdkVerifier="",sdkRedirect:URL|undefined,sdkDiscovery:OAuthDiscoveryState|undefined;
    const authProvider:OAuthClientProvider={
      redirectUrl:"http://127.0.0.1:8788/sdk-callback",
      clientMetadata:{client_name:"SDK OAuth state machine fixture",redirect_uris:["http://127.0.0.1:8788/sdk-callback"],grant_types:["authorization_code","refresh_token"],response_types:["code"],token_endpoint_auth_method:"none"},
      state:()=>"sdk-persisted-state",
      clientInformation:()=>sdkRegistration,saveClientInformation:value=>{sdkRegistration=structuredClone(value);},
      tokens:()=>sdkTokens,saveTokens:value=>{sdkTokens=structuredClone(value);},
      redirectToAuthorization:value=>{sdkRedirect=value;},saveCodeVerifier:value=>{sdkVerifier=value;},codeVerifier:()=>sdkVerifier,
      discoveryState:()=>sdkDiscovery,saveDiscoveryState:value=>{sdkDiscovery=structuredClone(value);},
      invalidateCredentials:kind=>{if(kind==="all"||kind==="client")sdkRegistration=undefined;if(kind==="all"||kind==="tokens")sdkTokens=undefined;if(kind==="all"||kind==="verifier")sdkVerifier="";if(kind==="all"||kind==="discovery")sdkDiscovery=undefined;},
    };
    assert.equal(await auth(authProvider,{serverUrl:`${base}/mcp`,scope:"growth:read"}),"REDIRECT");
    assert.ok(sdkRegistration?.client_id);assert.ok(sdkVerifier.length>=43);assert.ok(sdkRedirect);assert.equal(sdkRedirect.searchParams.get("code_challenge_method"),"S256");
    const sdkAuthorization=await request(`${sdkRedirect.pathname}${sdkRedirect.search}`);
    assert.equal(sdkAuthorization.status,302,JSON.stringify(sdkAuthorization.body));
    const sdkNonce=new URL(sdkAuthorization.headers.get("location")!).searchParams.get("request")!;
    assert.equal((await request(`/api/oauth/requests/${sdkNonce}`,undefined,human)).status,200);
    const sdkConsent=await request(`/api/oauth/requests/${sdkNonce}/decision`,{approved:true,organizationId:"org-a"},human);
    assert.equal(sdkConsent.status,200,JSON.stringify(sdkConsent.body));
    const sdkCallback=new URL(sdkConsent.body.redirectUrl);assert.equal(sdkCallback.searchParams.get("state"),"sdk-persisted-state");
    assert.equal(await auth(authProvider,{serverUrl:`${base}/mcp`,authorizationCode:sdkCallback.searchParams.get("code")!}),"AUTHORIZED");
    assert.equal(sdkTokens?.issuer,base);assert.equal(sdkRegistration?.issuer,base);
    const oauthSdkClient=new Client({name:"sdk-authenticated-fixture",version:"1.0.0"});clients.push(oauthSdkClient);
    await oauthSdkClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),{authProvider}));
    const sdkAuthenticatedWorkspace=await oauthSdkClient.callTool({name:"workspace.read",arguments:{}});assert.equal(sdkAuthenticatedWorkspace.isError,false);
    const beforeRefresh=sdkTokens!.access_token,refreshBefore=sdkTokens!.refresh_token;
    assert.equal(await auth(authProvider,{serverUrl:`${base}/mcp`}),"AUTHORIZED");
    assert.notEqual(sdkTokens!.access_token,beforeRefresh);assert.notEqual(sdkTokens!.refresh_token,refreshBefore);
    assert.deepEqual((await oauthSdkClient.callTool({name:"workspace.read",arguments:{}})).structuredContent,sdkAuthenticatedWorkspace.structuredContent);
    assert.equal((await request("/v1/operations/workspace.read",{},{authorization:`Bearer ${beforeRefresh}`})).status,401);
    const revokedSdkAccess=sdkTokens!.access_token;
    assert.equal((await request("/oauth/revoke",{client_id:sdkRegistration!.client_id,token:sdkTokens!.refresh_token})).status,200);
    await assert.rejects(oauthSdkClient.listTools());
    assert.equal((await request("/mcp",{jsonrpc:"2.0",id:1,method:"tools/list",params:{}},{authorization:`Bearer ${revokedSdkAccess}`,accept:"application/json, text/event-stream"})).status,401);

    const token = await issue();
    const bearer = { authorization: `Bearer ${token.access_token}` };
    const hostileOrigin=await request("/mcp",{jsonrpc:"2.0",id:1,method:"tools/list",params:{}},{...bearer,origin:"https://hostile.example.test",accept:"application/json, text/event-stream"});
    assert.equal(hostileOrigin.status,403);
    const hostileHost=await app.inject({method:"POST",url:"/mcp",headers:{...bearer,host:"hostile.example.test",accept:"application/json, text/event-stream"},payload:{jsonrpc:"2.0",id:1,method:"tools/list",params:{}}});
    assert.equal(hostileHost.statusCode,403);
    const client = new Client({ name: "growth-fixture", version: "1.0.0" }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer } }));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, growthOperationDescriptors.length);
    for (const descriptor of growthOperationDescriptors) {
      const tool = tools.find(candidate => candidate.name === descriptor.operation);
      assert.ok(tool, descriptor.operation);
      assert.deepEqual(tool.inputSchema, descriptor.inputSchema);
      assert.deepEqual(tool.outputSchema, descriptor.outputSchema);
      assert.equal(tool.description, descriptor.description);
    }
    const toolCall = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.structuredContent as Record<string, any>;
    };
    const workspace = await toolCall("workspace.read");
    const restWorkspace = await request("/v1/operations/workspace.read", {}, bearer);
    assert.equal(restWorkspace.status, 200, JSON.stringify(restWorkspace.body));
    assert.deepEqual(restWorkspace.body, workspace);
    const internal = await invokeInternalGrowthOperation(core, { operation: "workspace.read", control: "invoke", input: {}, actor: { subject: "alice" }, authority: { tenantId: "org-a" }, operationId: "internal-workspace", requestId: "fixture-workspace", taskId: "fixture-task", conversationId: "fixture-chat" } as ProductCapabilityInvocation);
    assert.deepEqual(internal.value, workspace);
    const descriptor = growthOperationDescriptors.find(value => value.operation === "workspace.read")!;
    const signedCommand = {version:"1", requestId:"signed-workspace-fixture", operationId:"signed-workspace-fixture", taskId:"signed-task", conversationId:"signed-chat", actor:growthAgentActor(config,"alice"),
      authority:{kind:"product",originProduct:"growth",destinationProduct:"growth",originTenantId:"org-a",tenantId:"org-a",mappingRef:"growth:org-a",policyRevision:growthAgentPublication.policy.revision,
        manifestDigest:growthAgentPublication.manifest.digest,descriptorDigest:growthAgentDigest(descriptor),handlerRef:descriptor.handlerRef},
      bindingId:"fixture-binding",bindingDigest:"a".repeat(64),operation:"workspace.read",control:"invoke",input:{}};
    const signedToken = await new SignJWT({product:"growth",requestDigest:growthAgentDigest(signedCommand)}).setProtectedHeader({alg:"RS256",kid:"agents-v1"})
      .setIssuer("https://agents.kasitek.co.za").setAudience("product-capability-actions").setSubject("agents-worker").setJti(randomBytes(16).toString("hex")).setIssuedAt().setExpirationTime("60s").sign(keys.privateKey);
    const signedResult = await request("/internal/agents/capabilities",signedCommand,{authorization:`Bearer ${signedToken}`});
    assert.equal(signedResult.status,200,JSON.stringify(signedResult.body));
    assert.deepEqual(signedResult.body.value,workspace);
    assert.equal((await request("/internal/agents/capabilities",{...signedCommand,input:{injected:true}},{authorization:`Bearer ${signedToken}`})).status,401);


    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aTocAAAAASUVORK5CYII=", "base64");
    const transfer = await toolCall("content.media.transfer.prepare", {mimeType:"image/png",fileName:"fixture.png",byteSize:png.length,sha256:createHash("sha256").update(png).digest("hex"),_requestId:"http-media-transfer"});
    assert.equal(transfer.state,"succeeded");
    assert.equal((await pool.query('SELECT count(*) FROM "ContentMediaAsset"')).rows[0].count,"0");
    const uploaded = await fetch(transfer.result.uploadUrl, {method:"PUT",headers:{...bearer,"content-type":"application/octet-stream"},body:png});
    assert.equal(uploaded.status,200,await uploaded.text());
    const mediaArgs={transferId:transfer.result.transferId,_requestId:"http-media-finalize"};
    const mediaSaved=await toolCall("content.media.upload",mediaArgs);
    assert.equal(mediaSaved.state,"succeeded");
    assert.equal(mediaSaved.review.decisionSource,"requested_draft");
    assert.deepEqual(await toolCall("content.media.upload",mediaArgs),mediaSaved);
    assert.equal((await pool.query('SELECT count(*) FROM "ContentMediaAsset"')).rows[0].count,"1");

    await pool.query(`INSERT INTO "Customer"(id,"orgId","displayName","updatedAt") VALUES('customer','org-a','Fixture customer',NOW());
      INSERT INTO "CustomerIdentity"(id,"orgId","customerId",channel,"externalId","identityKey","updatedAt") VALUES('identity','org-a','customer','whatsapp','+123','wa:+123',NOW());
      INSERT INTO "WhatsappConnection"(id,"userId","orgId","phoneNumberId","accessTokenEncrypted","wabaId","currentQualityRating","authMethod","dailyLimitEstimate","updatedAt") VALUES('whatsapp','alice','org-a','phone','unused','waba','GREEN','manual',10,NOW());
      INSERT INTO "WhatsappContact"(id,"userId","orgId","customerId",phone,"fullName",tags,"listLabel","optIn","updatedAt") VALUES('contact','alice','org-a','customer','+123','Fixture customer',ARRAY['customer'],'approved',true,NOW());
      INSERT INTO "WhatsappContactListMembership"(id,"userId","orgId","contactId","listLabel",tags,"optIn","updatedAt") VALUES('membership-contact','alice','org-a','contact','approved',ARRAY['customer'],true,NOW());
      INSERT INTO "WhatsappTemplate"(id,"userId","orgId","connectionId","templateName",language,category,status,body,"updatedAt") VALUES('template','alice','org-a','whatsapp','welcome','en','MARKETING','APPROVED','Fixture template',NOW());
      INSERT INTO "WhatsappCampaign"(id,"userId","orgId","connectionId","templateId",name,"templateName","templateLanguage",status,"updatedAt") VALUES('campaign','alice','org-a','whatsapp','template','Fixture campaign','welcome','en','DRAFT',NOW());
      INSERT INTO "Conversation"(id,channel,"customerIdentifier","customerName","customerId","orgId","unreadCount","lastMessageAt","updatedAt") VALUES('conversation','whatsapp','wa:whatsapp:+123','Fixture customer','customer','org-a',1,NOW(),NOW());
      INSERT INTO "Message"(id,"conversationId",sender,content,"providerMessageId") VALUES('message','conversation','customer','Fixture message','provider-message');
      INSERT INTO "BookingService"(id,"orgId",name,"durationMinutes","updatedAt") VALUES('booking-service','org-a','Consultation',30,NOW());
      INSERT INTO "Booking"(id,"orgId","serviceId","customerId","contactName","contactPhone","scheduledStart","scheduledEnd",status,"updatedAt") VALUES('booking','org-a','booking-service','customer','Fixture customer','+123',NOW()+interval '1 day',NOW()+interval '1 day 30 minutes','CONFIRMED',NOW());`);
    const readFamilies:[string,Record<string,unknown>,string|undefined][]=[
      ["contacts.list",{},"contacts"],["customers.get",{customerId:"customer"},undefined],
      ["inbox.conversations.list",{},"conversations"],["inbox.messages.list",{conversationId:"conversation"},"messages"],
      ["bookings.services.list",{},"services"],["bookings.list",{},"bookings"],["bookings.get",{bookingId:"booking"},undefined],
      ["campaigns.list",{},"campaigns"],["campaigns.get",{campaignId:"campaign"},undefined],
      ["templates.list",{},"templates"],["connections.list",{},"connections"],
    ];
    for(const [operation,input,collection] of readFamilies){
      const sdk=await toolCall(operation,input);
      if(collection)assert(sdk.result[collection].length>0,operation);
      if(operation==="customers.get")assert.equal(sdk.result.customer.customer.id,"customer");
      if(operation==="bookings.get")assert.equal(sdk.result.booking.id,"booking");
      const rest=await request(`/v1/operations/${operation}`,input,bearer);assert.equal(rest.status,200,JSON.stringify(rest.body));
      const internal=await invokeInternalGrowthOperation(core,{operation,control:"invoke",input,actor:{subject:"alice"},authority:{tenantId:"org-a"},operationId:`family-${operation}`,requestId:`family-${operation}`,taskId:"fixture-task",conversationId:"fixture-chat"} as ProductCapabilityInvocation);
      const normalize=(value:unknown):unknown=>{if(Array.isArray(value))return value.map(normalize);if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([key])=>operation!=="connections.list"||!["updatedAt","updated_at"].includes(key)).map(([key,item])=>[key,normalize(item)]));return value;};
      assert.deepEqual(normalize(rest.body),normalize(sdk),`${operation}:REST`);assert.deepEqual(normalize(internal.value),normalize(sdk),`${operation}:internal`);
    }

    const timingContext=(await resolveGrowthOAuthContext(core,token.access_token))!;
    const measure=async(run:()=>Promise<unknown>)=>{for(let i=0;i<5;i++)await run();const samples:number[]=[];for(let i=0;i<10;i++){const start=performance.now();await run();samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);return {p50:samples[4],p95:samples[9]};};
    const directTiming=await measure(()=>executeGrowthOperation(core,timingContext,{operation:"workspace.read",input:{}}));
    const sdkTiming=await measure(()=>client.callTool({name:"workspace.read",arguments:{}}));
    await mkdir(new URL("../../../../.audit/",import.meta.url),{recursive:true});
    await writeFile(new URL("../../../../.audit/growth-access-latency.json",import.meta.url),JSON.stringify({environment:"local isolated PostgreSQL and loopback HTTP; deterministic fixture",warmup:5,samples:10,directMs:directTiming,sdkMs:sdkTiming,deltaMs:{p50:sdkTiming.p50-directTiming.p50,p95:sdkTiming.p95-directTiming.p95}},null,2));

    const draft = { title: "Reviewed fixture", content: "Exact approved copy", channels: ["FACEBOOK"], channelSelections: { FACEBOOK: "facebook" } };
    const args = { draft, _requestId: "sdk-draft-fixture" };
    const noIdentity = await client.callTool({name:"content.posts.draft.create",arguments:{draft}});
    assert.equal(noIdentity.isError,true);
    assert.equal((noIdentity.structuredContent as any).code,"operation_identity_required");
    const draftSaved = await toolCall("content.posts.draft.create", args);
    assert.equal(draftSaved.state, "succeeded");
    assert.equal(draftSaved.review.decisionSource, "requested_draft");
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count, "1");
    assert.equal((await request(`/api/operations/reviews/${draftSaved.review.id}/decision`, { decision: "approve", payloadDigest: "wrong" }, human)).status, 409);
    const second = await issue();
    assert.equal((await request(`/v1/operation-reviews/${draftSaved.review.id}`, undefined, { authorization: `Bearer ${second.access_token}` })).status, 404);
    const committed = await toolCall("content.posts.draft.create", args);
    assert.deepEqual(committed, draftSaved);
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count, "1");
    const reviewed=async(name:string,input:Record<string,unknown>,requestId:string)=>{
      const proposal=await toolCall(name,{...input,_requestId:requestId});assert.equal(proposal.state,"approval_required",JSON.stringify(proposal));
      const decision=await request(`/api/operations/reviews/${proposal.review.id}/decision`,{decision:"approve",payloadDigest:proposal.review.payloadDigest},human);
      assert.equal(decision.status,200,JSON.stringify(decision.body));
      const args={...input,_requestId:requestId,_reviewId:proposal.review.id};const outcome=await toolCall(name,args);assert.equal(outcome.state,"succeeded",JSON.stringify(outcome));return {outcome,args};
    };
    const flowId=committed.result.post.id;
    const firstSchedule=new Date(Date.now()+3600000).toISOString(),secondSchedule=new Date(Date.now()+7200000).toISOString();
    await reviewed("content.posts.schedule",{postId:flowId,scheduledFor:firstSchedule},"flow-schedule");
    assert.equal((await pool.query('SELECT status FROM "SocialPost" WHERE id=$1',[flowId])).rows[0].status,"SCHEDULED");
    await reviewed("content.posts.reschedule",{postId:flowId,scheduledFor:secondSchedule},"flow-reschedule");
    assert.equal((await pool.query('SELECT "scheduledFor" FROM "SocialPost" WHERE id=$1',[flowId])).rows[0].scheduledFor.toISOString(),secondSchedule);
    await reviewed("content.posts.unschedule",{postId:flowId},"flow-unschedule");
    assert.equal((await pool.query('SELECT status FROM "SocialPost" WHERE id=$1',[flowId])).rows[0].status,"DRAFT");
    const preflight=await toolCall("content.posts.publish_batch.preflight",{postId:flowId});
    assert(preflight.result.targets.every((target:any)=>target.state==="READY"),JSON.stringify(preflight));
    const published=await reviewed("content.posts.publish_batch",{postId:flowId},"flow-publish-batch");
    const admittedJob=(await pool.query('SELECT id,status FROM "SocialPublishJob" WHERE "postId"=$1',[flowId])).rows[0];
    assert.equal(admittedJob.status,"QUEUED");assert.equal(await claimPublishJob(pool,admittedJob.id,["QUEUED"]),true);
    let providerCalls=0;
    const providerFetch:typeof fetch=async(url,init)=>{providerCalls++;assert.match(String(url),/graph.facebook.com.*fixture-page\/feed$/);assert.equal(new URLSearchParams(String(init?.body)).get("message"),draft.content);return Response.json({id:"fixture-confirmed-external-post"});};
    const providerResult=await executeSocialPublishJob(pool,admittedJob.id,{config,fetch:providerFetch});
    assert.equal(providerResult.externalPostId,"fixture-confirmed-external-post");
    await executeSocialPublishJob(pool,admittedJob.id,{config,fetch:providerFetch});assert.equal(providerCalls,1);
    const status=await toolCall("content.posts.publish_batch.status",{postId:flowId});
    assert.equal(status.result.batch.status,"SUCCEEDED");
    assert.equal((await pool.query('SELECT "externalPostId" FROM "SocialPublishJob" WHERE id=$1',[admittedJob.id])).rows[0].externalPostId,"fixture-confirmed-external-post");
    assert.deepEqual((await request("/v1/operations/content.posts.publish_batch.status",{postId:flowId},bearer)).body,status);
    const internalStatus=await invokeInternalGrowthOperation(core,{operation:"content.posts.publish_batch.status",control:"invoke",input:{postId:flowId},actor:{subject:"alice"},authority:{tenantId:"org-a"},operationId:"internal-flow-status",requestId:"internal-flow-status",taskId:"fixture-task",conversationId:"fixture-chat"} as ProductCapabilityInvocation);
    assert.deepEqual(internalStatus.value,status);
    await toolCall("content.posts.publish_batch",published.args);
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPublishBatch" WHERE "postId"=$1',[flowId])).rows[0].count,"1");
    const editable = await toolCall("content.posts.get", { postId: flowId });
    const editInput = { postId: flowId, content: "Exact corrected Facebook caption", expectedUpdatedAt: editable.result.post.updated_at };
    const editProposal = await toolCall("content.posts.update_published", { ...editInput, _requestId: "published-edit-review" });
    assert.equal(editProposal.state, "approval_required");
    assert.equal(editProposal.review.preview.content, editInput.content);
    assert.equal(editProposal.review.preview.previousContent, draft.content);
    assert.equal(editProposal.review.preview.accounts[0].externalAccountId, "fixture-page");
    const removePhotoProposal = await toolCall("content.posts.update_published", { ...editInput, removePhoto: true, _requestId: "published-remove-photo-review" });
    assert.equal(removePhotoProposal.state, "approval_required");
    assert.equal(removePhotoProposal.review.preview.removePhoto, true);
    assert.match(removePhotoProposal.review.preview.targetLabel, /remove photo/);
    assert.deepEqual(removePhotoProposal.review.preview.media, []);
    assert.notEqual(removePhotoProposal.review.payloadDigest, editProposal.review.payloadDigest);
    assert.equal((await pool.query('SELECT metadata FROM "SocialPublishJob" WHERE id=$1', [admittedJob.id])).rows[0].metadata?._kasitek_edit_intent, undefined);
    const internalEdit = await invokeInternalGrowthOperation(core, { operation: "content.posts.update_published", control: "prepare", input: { ...editInput, _requestId: "internal-published-edit-review" }, actor: { subject: "alice" }, authority: { tenantId: "org-a" }, operationId: "internal-published-edit-review", requestId: "internal-published-edit-review", taskId: "fixture-task", conversationId: "fixture-chat" } as ProductCapabilityInvocation);
    assert.equal((internalEdit.value as any).review.preview.content, editInput.content);
    assert.equal((await request(`/api/operations/reviews/${editProposal.review.id}/decision`, { decision: "approve", payloadDigest: editProposal.review.payloadDigest }, human)).status, 200);
    await pool.query('UPDATE "SocialPost" SET "updatedAt"="updatedAt"+interval \'1 second\' WHERE id=$1', [flowId]);
    const staleEdit = await client.callTool({ name: "content.posts.update_published", arguments: { ...editInput, _requestId: "published-edit-review", _reviewId: editProposal.review.id } });
    assert.equal(staleEdit.isError, true);
    assert.equal((staleEdit.structuredContent as any).code, "operation_review_conflict");
    assert.equal((await pool.query('SELECT content FROM "SocialPost" WHERE id=$1', [flowId])).rows[0].content, draft.content);
    assert.equal((await pool.query('SELECT metadata FROM "SocialPublishJob" WHERE id=$1', [admittedJob.id])).rows[0].metadata?._kasitek_edit_intent, undefined);
    const changed = await client.callTool({ name: "content.posts.draft.create", arguments: { ...args, draft: { ...draft, content: "Changed after approval" }, _reviewId: draftSaved.review.id } });
    assert.equal(changed.isError, true);
    assert.equal((changed.structuredContent as any).code, "operation_review_conflict");
    assert.deepEqual((await request("/v1/content/posts", undefined, bearer)).body, (await request("/v1/operations/content.posts.list", {}, bearer)).body.result);

    const aliasArgs = { ...draft, title: "Alias draft", _requestId: "alias-draft-fixture" };
    const alias = await request("/v1/content/posts", aliasArgs, bearer);
    assert.equal(alias.status, 201, JSON.stringify(alias.body));
    const aliasSaved = await request("/v1/content/posts", aliasArgs, bearer);
    assert.equal(aliasSaved.status, 201, JSON.stringify(aliasSaved.body));
    assert.equal((await request("/v1/content/posts", aliasArgs, bearer)).status, 201);
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count, "2");
    const postId = (await pool.query('SELECT id FROM "SocialPost" WHERE title=$1', ["Alias draft"])).rows[0].id;
    const patchArgs = { ...draft, title: "Updated alias", _requestId: "alias-patch-fixture" };
    const patch = await request(`/v1/content/posts/${postId}`, patchArgs, bearer, "PATCH");
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    const patched = await request(`/v1/content/posts/${postId}`, patchArgs, bearer, "PATCH");
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal((await pool.query('SELECT title FROM "SocialPost" WHERE id=$1', [postId])).rows[0].title, "Updated alias");

    const canceledJob=(await pool.query('SELECT id FROM "SocialPublishJob" WHERE "postId"=$1',[postId])).rows[0].id;
    await reviewed("content.jobs.cancel",{jobId:canceledJob},"flow-cancel-job");
    assert.equal((await pool.query('SELECT status FROM "SocialPublishJob" WHERE id=$1',[canceledJob])).rows[0].status,"CANCELED");

    const longContent="Large exact approved copy. ".repeat(400).trim();
    const largeArgs={...draft,title:"Large typed draft",content:longContent,_requestId:"large-typed-draft"};
    const largeProposal=await request("/v1/content/posts",largeArgs,bearer);
    assert.equal(largeProposal.status,201,JSON.stringify(largeProposal.body));
    const largeResume=largeArgs;
    assert.equal(largeProposal.body.review.requestId,largeArgs._requestId);
    assert.equal(largeProposal.body.result.encoding,"json");
    const invalidObservation=await request("/v1/content/posts",{...largeResume,_continuation:"invalid-receipt-continuation"},bearer);
    assert.equal(invalidObservation.status,409,JSON.stringify(invalidObservation.body));
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count,"3");

    const largeCommit=await request("/v1/content/posts",largeResume,bearer);
    assert.equal(largeCommit.status,201,JSON.stringify(largeCommit.body));
    assert.equal(largeCommit.body.result.encoding,"json");
    assert(Buffer.byteLength(JSON.stringify(largeCommit.body))<=8192);
    let writeChunk=largeCommit.body.result,writeText="";
    for(let page=0;page<100;page++){
      assert.equal(writeChunk.offset,Array.from(writeText).length);writeText+=writeChunk.chunk;
      if(!writeChunk.continuation)break;
      const next=await request("/v1/content/posts",{...largeResume,_continuation:writeChunk.continuation},bearer);
      assert.equal(next.status,201,JSON.stringify(next.body));
      assert(Buffer.byteLength(JSON.stringify(next.body))<=8192);writeChunk=next.body.result;
    }
    const largeSaved=JSON.parse(writeText);
    assert.equal(largeSaved.state,"succeeded");assert.equal(largeSaved.result.post.content,longContent);
    const largeId=largeSaved.result.post.id;
    let readChunk=(await request(`/v1/content/posts/${largeId}`,undefined,bearer)).body,readText="";
    assert.equal(readChunk.encoding,"json");
    for(let page=0;page<100;page++){
      assert.equal(readChunk.offset,Array.from(readText).length);readText+=readChunk.chunk;
      if(!readChunk.continuation)break;
      const next=await request(`/v1/content/posts/${largeId}?_continuation=${encodeURIComponent(readChunk.continuation)}`,undefined,bearer);
      assert.equal(next.status,200,JSON.stringify(next.body));
      assert(Buffer.byteLength(JSON.stringify(next.body))<=8192);readChunk=next.body;
    }
    const largeRead=JSON.parse(readText);
    assert.equal(largeRead.state,"succeeded");assert.equal(largeRead.result.post.content,longContent);
    assert.deepEqual(largeRead.result.post,largeSaved.result.post);
    assert.equal((await request("/v1/content/posts",largeResume,bearer)).status,201);
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count,"3");

    const previewAction = async (requestId:string) => {
      const input = {action:"content.posts.delete",input:{postId:largeId},requestId};
      let result = await toolCall("content.actions.preview", input);
      assert.equal(result.state,"succeeded");
      if (result.result.encoding === "json") {
        let encoded = "";
        for (let page=0;page<100;page++) {
          encoded += result.result.chunk;
          if (!result.result.continuation) break;
          result = await toolCall("content.actions.preview", {...input,_continuation:result.result.continuation});
        }
        result = JSON.parse(encoded);
      }
      return result.result.preview;
    };
    const stale = await previewAction("stale-review-fixture");
    await request(`/api/operations/reviews/${stale.id}/decision`, { decision: "approve", payloadDigest: stale.payloadDigest }, human);
    await pool.query('UPDATE "SocialChannelConnection" SET "updatedAt"=NOW()+interval \'1 second\' WHERE id=\'facebook\'');
    const staleResult = await client.callTool({ name: "content.posts.delete", arguments: {postId:largeId,_previewId:stale.id} });
    assert.equal(staleResult.isError, true);
    assert.equal((staleResult.structuredContent as any).code, "operation_review_conflict");

    const rejectedProposal = await previewAction("rejected-fixture");
    await request(`/api/operations/reviews/${rejectedProposal.id}/decision`, { decision: "reject", payloadDigest: rejectedProposal.payloadDigest }, human);
    const rejectedReplay = await toolCall("content.posts.delete", {postId:largeId,_previewId:rejectedProposal.id});
    assert.equal(rejectedReplay.state, "rejected");
    const accessEvents = (await pool.query(`SELECT envelope->'data' AS data FROM analytics_outbox WHERE contract_name='growth.agent.access@1'`)).rows.map(row => row.data);
    for (const action of ["proposed", "approved", "rejected", "succeeded"]) assert(accessEvents.some(event => event.action === action), action);
    assert(accessEvents.every(event => Object.keys(event).sort().join(",") === "action,kind,operation,outcome"));
    for(const event of accessEvents.filter(event=>event.action==="succeeded")) assert.equal(event.outcome,["content.posts.publish","content.posts.publish_batch","content.posts.publish_batch.retry","content.posts.schedule","content.posts.reschedule","content.jobs.retry"].includes(event.operation)?"admitted":"completed");

    const readToken = await issue("growth:read");
    const reader = new Client({ name: "readonly-fixture", version: "1.0.0" }); clients.push(reader);
    await reader.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${readToken.access_token}` } } }));
    assert.ok((await reader.listTools()).tools.every(tool => !["content.posts.draft.create", "content.posts.publish"].includes(tool.name)));
    const denied = await reader.callTool({ name: "content.posts.draft.create", arguments: args });
    assert.equal(denied.isError, true);
    assert.equal((denied.structuredContent as any).code, "operation_scope_denied");
    assert.equal((await request("/v1/content/posts", aliasArgs, { authorization: `Bearer ${readToken.access_token}` })).status, 403);
    const secondBearer={authorization:`Bearer ${second.access_token}`};
    const revokedArgs={action:"content.posts.delete",input:{postId},requestId:"revoke-approved-fixture"};
    const revokedProposal=await request("/v1/operations/content.actions.preview",revokedArgs,secondBearer);
    const revokedPreview=revokedProposal.body.result.preview;
    await request(`/api/operations/reviews/${revokedPreview.id}/decision`,{decision:"approve",payloadDigest:revokedPreview.payloadDigest},human);
    await request("/oauth/revoke",{client_id:clientId,token:second.refresh_token});
    assert.equal((await request("/v1/operations/content.posts.delete",{postId,_previewId:revokedPreview.id},secondBearer)).status,401);
    await request("/oauth/revoke", { client_id: clientId, token: token.refresh_token });
    await assert.rejects(client.listTools(), /OAuth access expired or revoked/);
    const revoked = await request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { ...bearer, accept: "application/json, text/event-stream" });
    assert.equal(revoked.status, 401);
    assert.match(revoked.headers.get("www-authenticate")!, /resource_metadata/);
    assert.equal((await request("/v1/operations/workspace.read", {}, bearer)).status, 401);
    assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count, "3");
  } finally {
    for (const client of clients) await client.close();
    await app?.close();
    await fixture.close();
    await rm(mediaDirectory,{recursive:true,force:true});
  }
});
