import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import pg from "pg";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CoreContext } from "../src/context.js";
import type { RequestContext } from "../src/identity/request-context.js";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { installPgTimestampParsers } from "../src/db.js";
import { oauthDigest } from "../src/oauth/index.js";
import { registerGrowthMcpRoutes } from "../src/operations/mcp.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import type { OperationReviewRow } from "../src/operations/reviews.js";
import { MCP_2026_VERSION, contentConfirmationMessage, handleGrowthMcp2026, isMcp2026Request,
  mcpContentConfirmationDecision, mcpContentFormMode, mcpConfirmationResponseShape, readMcpContentConfirmation,
  sealMcpContentConfirmation } from "../src/operations/mcp-2026.js";

const core = { config: readConfig({ DATABASE_URL: "postgres://unused", ENVIRONMENT: "test",
  GROWTH_MCP_CONFIRMATION_SECRET: "isolated-mcp-confirmation-secret-with-32-bytes" }) } as CoreContext;
const context: RequestContext = { principal: { kind: "oauth_user", id: "connection-a", subjectUserId: "alice", clientId: "fixture-client" },
  userId: "alice", clientId: "fixture-client", organizationId: "org-a", apiScopes: new Set(["growth:read", "growth:publish"]),
  effectiveGrants: new Set(), idempotencyKey: null, correlationId: null, causationId: null };
const now = Date.parse("2026-11-02T00:00:00Z");
const review = { id: "review-a", operation: "content.posts.publish", payloadDigest: "f".repeat(64), requestKey: "stable-request-a",
  expiresAt: new Date(now + 30 * 60_000), snapshot: { preview: JSON.stringify({ action: "Publish", content: "Hello world\nExact second line",
    accounts: [{ platform: "FACEBOOK", displayName: "Fixture Page", externalAccountId: "page-a" }],
    media: [{ assetId: "image-a", fileName: "image.jpg", altText: "Exact image description" }], requestedScheduledFor: "2026-11-03T12:00:00+02:00" }) } } as OperationReviewRow;
const args = { postId: "post-a", platform: "FACEBOOK", _requestId: "stable-request-a" };

test("confirmation diagnostics contain only fixed categorical structure", () => {
  const shape=mcpConfirmationResponseShape({requestState:"do-not-log",inputResponses:{secretKey:{action:"unexpected-secret",content:{confirm:"secret-content",private:"secret"},error:{message:"secret"}}}});
  assert.deepEqual(shape,{state_present:true,responses_object:true,responses_count:1,response_object:true,response_error:true,response_result:false,response_action:"other",content_object:true,content_count:2,confirm_boolean:false,decision_string:false});
  assert.equal(JSON.stringify(shape).includes("secret"),false);
  const sealed=sealMcpContentConfirmation(core,context,review,args,now);
  assert.throws(()=>readMcpContentConfirmation(core,context,sealed,"content.posts.publish",{...args,postId:"changed"},now),
    error=>(error as {confirmationReason:string}).confirmationReason==="state_arguments");
  assert.throws(()=>mcpContentConfirmationDecision({action:"accept",content:{}}),
    error=>(error as {confirmationReason:string}).confirmationReason==="decision_schema");
});

test("MCP2026 detects protocol requests without changing legacy request routing", () => {
  assert.equal(isMcp2026Request({headers: {"mcp-protocol-version": MCP_2026_VERSION}, body: {}}), true);
  assert.equal(isMcp2026Request({headers: {}, body: {method: "server/discover"}}), true);
  assert.equal(isMcp2026Request({headers: {"mcp-protocol-version": "2027-01-01"}, body: {}}), true);
  assert.equal(isMcp2026Request({headers: {}, body: {method: "tools/call", params: {_meta: {"io.modelcontextprotocol/protocolVersion": MCP_2026_VERSION}}}}), true);
  assert.equal(isMcp2026Request({headers: {"mcp-protocol-version": "2025-11-25"}, body: {method: "tools/call"}}), false);
});

test("form confirmation uses declared capabilities and restricts OpenAI client metadata identities", () => {
  assert.equal(mcpContentFormMode({}, "fixture-client"), null);
  assert.equal(mcpContentFormMode({elicitation: {url: {}}}, "fixture-client"), null);
  assert.equal(mcpContentFormMode({elicitation: {form: {}}}, "fixture-client"), "core");
  assert.equal(mcpContentFormMode({elicitation: {}}, "fixture-client"), null);
  for (const client of ["https://chatgpt.com/oauth/client.json", "https://chatgpt.com/oauth/connector-id/client.json"]) {
    assert.equal(mcpContentFormMode({elicitation: {form: {}}}, client), null);
    assert.equal(mcpContentFormMode({elicitation: {form: {}}, extensions: {"openai/elicitation": {}}}, client), null);
    assert.equal(mcpContentFormMode({elicitation: {form: {}}, extensions: {"openai/elicitation": {form: {}}}}, client), "openai");
  }
  assert.equal(mcpContentFormMode({extensions: {"openai/elicitation": {form: {}}}}, "fixture-client"), null);
});

test("confirmation protocol state binds exact input, principal, workspace, request and expiry", () => {
  const token = sealMcpContentConfirmation(core, context, review, args, now);
  const state = readMcpContentConfirmation(core, context, token, review.operation, args, now);
  assert.equal(state.reviewId, review.id);
  assert.equal(state.requestKey, review.requestKey);
  assert.equal(state.expires, now + 5 * 60_000);
  assert.notEqual(token, sealMcpContentConfirmation(core, context, review, args, now));
  for (const changed of [ {...context, organizationId: "org-b"}, {...context, userId: "bob"},
    {...context, clientId: "different-client"}, {...context, principal: {...context.principal, id: "other-connection"}},
    {...context, principal: {...context.principal, kind: "direct_user" as const}} ])
    assert.throws(() => readMcpContentConfirmation(core, changed, token, review.operation, args, now), /invalid or expired/);
  assert.throws(() => readMcpContentConfirmation(core, context, token, "content.posts.delete.published", args, now));
  assert.throws(() => readMcpContentConfirmation(core, context, token, review.operation, {...args, postId: "other"}, now));
  assert.throws(() => readMcpContentConfirmation(core, context, token, review.operation, {...args, _requestId: "other-request"}, now));
  assert.throws(() => readMcpContentConfirmation(core, context, token, review.operation, args, now + 5 * 60_000));
  assert.throws(() => readMcpContentConfirmation(core, context, "x" + token, review.operation, args, now));
  assert.throws(() => readMcpContentConfirmation(core, context, token.slice(0, -1) + (token.endsWith("a") ? "b" : "a"), review.operation, args, now));
  const rotated = { ...core, config: readConfig({DATABASE_URL:"postgres://unused", GROWTH_MCP_CONFIRMATION_SECRET:"rotated-isolated-confirmation-secret"}) };
  assert.throws(() => readMcpContentConfirmation(rotated, context, token, review.operation, args, now));
});

test("signed answer schema revision rejects old or different form interpretation", () => {
  const token=sealMcpContentConfirmation(core,context,review,args,now);
  const encoded=token.split(".")[0]!;
  const payload=JSON.parse(Buffer.from(encoded,"base64url").toString("utf8"));
  assert.equal(payload.answerSchema,"choice_v1");
  for (const revision of [{...payload,version:1},{...payload,answerSchema:"boolean_v1"}]) {
    const replacement=Buffer.from(JSON.stringify(revision)).toString("base64url");
    const mac=createHmac("sha256",core.config.rawEnv.GROWTH_MCP_CONFIRMATION_SECRET!).update("growth-content-mcp-form-v1\0"+replacement).digest("base64url");
    assert.throws(()=>readMcpContentConfirmation(core,context,replacement+"."+mac,"content.posts.publish",args,now),
      error=>(error as {confirmationReason:string}).confirmationReason==="state_payload");
  }
  assert.throws(()=>mcpContentConfirmationDecision({action:"accept",content:{confirm:true}}));
  assert.throws(()=>mcpContentConfirmationDecision({action:"accept",content:{decision:"true"}}));
});

test("confirmation state cannot outlive the owned preview or use an absent production secret", () => {
  const short = {...review, expiresAt: new Date(now + 1000)};
  const token = sealMcpContentConfirmation(core, context, short, args, now);
  assert.equal(readMcpContentConfirmation(core, context, token, review.operation, args, now).expires, now + 1000);
  for (const secret of [undefined, "too-short"]) {
    const unavailable = {...core, config: readConfig({DATABASE_URL:"postgres://unused",ENVIRONMENT:"production", GROWTH_MCP_CONFIRMATION_SECRET:secret})};
    assert.throws(() => sealMcpContentConfirmation(unavailable, context, review, args, now), /not configured/);
  }
});

test("only an explicit host form choice confirms; cancellation and forged flags never approve", () => {
  assert.equal(mcpContentConfirmationDecision({action:"accept",content:{decision:"confirm"}}), "approve");
  assert.equal(mcpContentConfirmationDecision({action:"accept",content:{decision:"cancel"}}), "reject");
  assert.equal(mcpContentConfirmationDecision({action:"decline"}), "reject");
  assert.equal(mcpContentConfirmationDecision({action:"cancel",content:null}), "reject");
  for (const value of [{approved:true}, {action:"accept"}, {action:"accept",content:{approved:true}},
    {action:"accept",content:{confirm:"true"}}, {action:"accept",content:{decision:"confirm",changedContent:"other"}}])
    assert.throws(() => mcpContentConfirmationDecision(value));
});

test("the form shows the complete frozen content and rejects any preview requiring truncation", () => {
  const message = contentConfirmationMessage(review)!;
  for (const value of ["Hello world\nExact second line", "Fixture Page", "FACEBOOK", "image.jpg", "Exact image description", "2026-11-03T12:00:00+02:00"])
    assert.ok(message.includes(value), value);
  assert.equal(contentConfirmationMessage({...review, snapshot:{preview:JSON.stringify({content:"x".repeat(70*1024)})}}), null);
  assert.equal(contentConfirmationMessage({...review, snapshot:{preview:"not json"}}), null);
});

test("MCP2026 JSON discovery and validation preserve stateless round trips", async () => {
  const app = Fastify({logger:false});
  app.post("/mcp", async (request,reply) => handleGrowthMcp2026(core, context, request,reply));
  const meta = {"io.modelcontextprotocol/protocolVersion":MCP_2026_VERSION,"io.modelcontextprotocol/clientCapabilities":{}};
  const send = (method:string, params:Record<string,unknown> = {_meta:meta}, version=MCP_2026_VERSION) => app.inject({method:"POST",url:"/mcp",
    headers:{"mcp-protocol-version":version,"mcp-method":method,...(typeof params.name === "string" ? {"mcp-name":params.name} : {})},payload:{jsonrpc:"2.0",id:1,method,params}});
  try {
    const discovery = await send("server/discover");
    assert.equal(discovery.statusCode,200);
    assert.equal(discovery.json().result.resultType,"complete");
    assert.ok(discovery.json().result.supportedVersions.includes(MCP_2026_VERSION));
    assert.deepEqual(discovery.json().result.capabilities,{tools:{}});
    assert.equal(discovery.headers["cache-control"],"no-store");
    assert.equal((await send("ping")).json().result.resultType,"complete");
    const unknown = await send("not-supported");
    assert.equal(unknown.statusCode,404);
    assert.equal(unknown.json().error.code,-32601);
    assert.equal(discovery.json().result._meta["io.modelcontextprotocol/serverInfo"].name,"kasitek-growth");
    assert.equal(discovery.json().result.protocolVersions,undefined);
    const wire = (headers:Record<string,string>, method="server/discover", name?:string) => app.inject({method:"POST",url:"/mcp",headers,
      payload:{jsonrpc:"2.0",id:2,method,params:{_meta:meta,...(name ? {name} : {})}}});
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION})).json().error.code,-32020);
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"ping"})).json().error.code,-32020);
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"tools/call"},"tools/call","missing")).json().error.code,-32020);
    const encoded = await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"prompts/get","mcp-name":"=?base64?"+Buffer.from("Héllo").toString("base64")+"?="},"prompts/get","Héllo");
    assert.equal(encoded.statusCode,404); // Encoded header agrees; unsupported method is separate.
    assert.equal((await wire({"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"tools/call","mcp-name":"=?base64?!!?="},"tools/call","missing")).json().error.code,-32020);
    assert.equal((await send("ping",{_meta:meta},"2025-11-25")).json().error.code,-32020);
    assert.equal((await send("ping",{})).statusCode,400);
    assert.equal((await send("ping",{_meta:{...meta,"io.modelcontextprotocol/clientCapabilities":[]}})).statusCode,400);
    assert.equal((await send("ping",{_meta:{...meta,"io.modelcontextprotocol/protocolVersion":"2027-01-01"}},"2027-01-01")).json().error.code,-32022);
    const forged = await send("tools/call",{_meta:meta,name:"content.posts.publish",arguments:args,requestState:"forged",inputResponses:{confirm:{action:"accept",content:{decision:"confirm"}}}});
    assert.equal(forged.json().result.isError,true);
    assert.equal(forged.json().result.structuredContent.code,"content_confirmation_invalid");
  } finally { await app.close(); }
});

const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("real MCP2026 host forms confirm an exact owned content action once and fail closed", {skip:!database,timeout:60000}, async () => {
  installPgTimestampParsers();
  const inventory = new pg.Pool({connectionString:database});
  const tables = (await inventory.query<{tablename:string}>(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows
    .map(row=>row.tablename).filter(name=>/^[A-Za-z_]+$/.test(name) && !name.startsWith("GrowthOAuth") &&
      !["GrowthOperationReview","GrowthMediaTransfer","analytics_outbox"].includes(name));
  await inventory.end();
  const fixture = await isolatedDatabase(database!, "mcp_form", tables);
  const {pool} = fixture;
  let app:Awaited<ReturnType<typeof buildApp>>|undefined;
  try {
    await pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",import.meta.url),"utf8"));
    for (const migration of ["20261101130000_growth_oauth.sql","20261101140000_growth_operation_reviews.sql","20261101150000_growth_media_transfers.sql","20261102190000_content_agent_workflows.sql"])
      await pool.query(await readFile(new URL(`../sql/${migration}`,import.meta.url),"utf8"));
    await pool.query(`INSERT INTO "User"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('alice','Alice','alice@example.test',now(),now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org-a','Fixture business','fixture-business','alice',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org-a','alice','OWNER',now());
      INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","updatedAt") VALUES('facebook','alice','org-a','FACEBOOK','CONNECTED','Fixture Page','page-a',now());`);
    const config = readConfig({DATABASE_URL:database!, ENVIRONMENT:"test", FRONTEND_URL:"http://localhost:3000", KASITEK_CORE_PUBLIC_URL:"http://localhost:4000",LOG_LEVEL:"silent",
      GROWTH_AGENT_ACCESS_ENABLED:"true",GROWTH_AGENT_EFFECTS_ENABLED:"true",KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE:"1000",
      GROWTH_MCP_CONFIRMATION_SECRET:"isolated-host-form-confirmation-secret-32-bytes", SOCIAL_TOKEN_ENCRYPTION_KEY:"isolated-social-fixture-secret"});
    await pool.query(`UPDATE "SocialChannelConnection" SET "accessToken"=$1,metadata=$2 WHERE id='facebook'`,
      [encryptSocialSecret(config,"synthetic-provider-token"),JSON.stringify({permissionsInspected:true,scope:"pages_manage_posts",tasks:["CREATE_CONTENT"]})]);
    const clientId = "https://chatgpt.com/oauth/client.json";
    await pool.query('INSERT INTO "GrowthOAuthClient"(id,name,"redirectUris") VALUES($1,\'Fixture host\',$2)',[clientId,["https://chatgpt.com/connector_platform_oauth_redirect"]]);
    const token = "growth_oauth_"+randomBytes(32).toString("base64url");
    const readToken = "growth_oauth_"+randomBytes(32).toString("base64url");
    for (const [id,bearer,scopes] of [["full",token,["growth:read","growth:draft","growth:publish","growth:manage"]],["read",readToken,["growth:read"]]] as const)
      await pool.query('INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt") VALUES($1,$2,\'alice\',\'org-a\',$3,$4,$5,now()+interval \'1 hour\')',
        [id,clientId,config.publicApiUrl+"/mcp",scopes,oauthDigest(bearer)]);
    app = await buildApp({pool,config},[registerGrowthMcpRoutes]);
    const formCapabilities = {elicitation:{form:{}},extensions:{"openai/elicitation":{form:{}}}};
    const invoke = async (name:string, arguments_:Record<string,unknown>, additions:Record<string,unknown>={}, bearer=token, capabilities:Record<string,unknown>=formCapabilities) => {
      const response = await app!.inject({method:"POST",url:"/mcp",headers:{host:"localhost:4000",authorization:"Bearer "+bearer,"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"tools/call","mcp-name":name},
        payload:{jsonrpc:"2.0",id:randomBytes(4).toString("hex"),method:"tools/call",params:{name,arguments:arguments_,_meta:{"io.modelcontextprotocol/protocolVersion":MCP_2026_VERSION,"io.modelcontextprotocol/clientCapabilities":capabilities},...additions}}});
      assert.equal(response.statusCode,200,response.body);
      return response.json().result;
    };
    const draftArgs = {_requestId:"mcp-form-draft-create",draft:{content:"Exact test text",title:"Fixture draft",channels:["FACEBOOK"],primaryChannelId:"facebook",channelSelections:{FACEBOOK:"facebook"}}};
    const draft = await invoke("content.posts.draft.create",draftArgs);
    assert.equal(draft.structuredContent?.state,"succeeded",JSON.stringify(draft));
    const postId = draft.structuredContent.result.post.id;
    assert.equal((await invoke("content.posts.draft.create",draftArgs)).structuredContent.result.post.id,postId,"direct drafts retain idempotent receipts");
    const blocked = await invoke("content.posts.draft.create",{...draftArgs,_requestId:"mcp-form-blocked-draft"});
    const blockedId = blocked.structuredContent.result.post.id;
    await pool.query('UPDATE "SocialPost" SET status=\'PUBLISHED\' WHERE id=$1',[blockedId]);
    await pool.query('UPDATE "SocialPublishJob" SET status=\'PUBLISHED\',"externalPostId"=\'synthetic-published-copy\' WHERE "postId"=$1',[blockedId]);
    const impossible = await invoke("content.posts.delete",{postId:blockedId,_requestId:"blocked-no-confirmation"});
    assert.equal(impossible.resultType,"complete");
    assert.equal(impossible.structuredContent.state,"validation_required");
    assert.equal(impossible.inputRequests,undefined,"known-invalid content must not solicit a futile approval");
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM "SocialPost" WHERE id=$1',[blockedId])).rows[0].count,1);
    await pool.query('UPDATE "SocialPost" SET status=\'DRAFT\',content=$2 WHERE id=$1',[blockedId,"x".repeat(70*1024)]);
    await pool.query('UPDATE "SocialPublishJob" SET status=\'PENDING\',"externalPostId"=NULL WHERE "postId"=$1',[blockedId]);
    const oversized = await invoke("content.posts.delete",{postId:blockedId,_requestId:"large-preview-not-truncated"});
    assert.equal(oversized.resultType,"complete");
    assert.equal(oversized.inputRequests,undefined);
    assert.match(oversized.structuredContent.message,/too large/);
    const draftCount = async () => (await pool.query('SELECT count(*)::int AS count FROM "SocialPost" WHERE id=$1',[postId])).rows[0].count;
    const deletion = {postId,_requestId:"mcp-delete-declined"};
    const unsupported = await invoke("content.posts.delete",deletion,{},token,{elicitation:{form:{}}});
    assert.equal(unsupported.resultType,"complete");
    assert.equal(unsupported.structuredContent.state,"approval_required","registered OpenAI requires the extension");
    assert.equal(await draftCount(),1);
    const proposed = await invoke("content.posts.delete",deletion);
    assert.equal(proposed.resultType,"input_required",JSON.stringify(proposed));
    const formId = Object.keys(proposed.inputRequests)[0]!;
    const form = proposed.inputRequests[formId].params;
    assert.deepEqual(form.requestedSchema,{type:"object",properties:{}});
    assert.equal(form._meta["openai/elicitation"].requestedSchema.properties.decision.type,"string");
    assert.deepEqual(form._meta["openai/elicitation"].requestedSchema.properties.decision.enum,["confirm","cancel"]);
    assert.equal(form._meta["openai/elicitation"].requestedSchema.properties.decision.default,"cancel");
    assert.ok(form.message.includes("Exact test text") && form.message.includes("Fixture Page"));
    const approve = {requestState:proposed.requestState,inputResponses:{[formId]:{action:"accept",content:{decision:"confirm"}}}};
    const hostUnsupported=await invoke("content.posts.delete",deletion,{requestState:proposed.requestState,inputResponses:{[formId]:{error:{code:-32602,message:"unsupported host form"}}}});
    assert.equal(hostUnsupported.structuredContent.state,"approval_required");
    assert.equal(hostUnsupported.structuredContent.review.state,"proposed");
    assert.equal(await draftCount(),1);
    const missingAnswer=await invoke("content.posts.delete",deletion,{requestState:proposed.requestState,inputResponses:{[formId]:{action:"accept",content:{}}}});
    assert.equal(missingAnswer.structuredContent.state,"approval_required");
    assert.equal(missingAnswer.structuredContent.review.state,"proposed");
    assert.equal(missingAnswer.structuredContent.review.decisionSource,null);
    assert.ok(missingAnswer.structuredContent.message.includes("client did not return"));
    const malformedAnswer=await invoke("content.posts.delete",deletion,{requestState:proposed.requestState,inputResponses:{[formId]:{action:"accept",content:{confirm:"true"}}}});
    assert.equal(malformedAnswer.structuredContent.code,"content_confirmation_invalid");
    const foreignEmpty=await invoke("content.posts.delete",deletion,{requestState:proposed.requestState,inputResponses:{[formId]:{action:"accept",content:{}}}},readToken);
    assert.equal(foreignEmpty.structuredContent.code,"content_confirmation_invalid");
    assert.equal(await draftCount(),1);
    const foreign = await invoke("content.posts.delete",deletion,approve,readToken);
    assert.equal(foreign.structuredContent.code,"content_confirmation_invalid");
    assert.equal(await draftCount(),1);
    const changed = await invoke("content.posts.delete",{...deletion,postId:"other"},approve);
    assert.equal(changed.structuredContent.code,"content_confirmation_invalid");
    const declined = await invoke("content.posts.delete",deletion,{requestState:proposed.requestState,inputResponses:{[formId]:{action:"decline"}}});
    assert.equal(declined.structuredContent.state,"rejected");
    assert.equal(await draftCount(),1);
    const rejectedReplay = await invoke("content.posts.delete",deletion,approve);
    assert.equal(rejectedReplay.isError,true,"a declined preview cannot later execute");
    const denied = await invoke("content.posts.delete",{postId,_requestId:"read-cannot-delete"},{},readToken);
    assert.equal(denied.structuredContent.code,"operation_scope_denied");
    const cancelArgs = {postId,_requestId:"mcp-delete-cancelled"};
    const cancel = await invoke("content.posts.delete",cancelArgs);
    const cancelId = Object.keys(cancel.inputRequests)[0]!;
    assert.equal((await invoke("content.posts.delete",cancelArgs,{requestState:cancel.requestState,inputResponses:{[cancelId]:{action:"accept",content:{decision:"cancel"}}}})).structuredContent.state,"rejected");
    assert.equal(await draftCount(),1);
    const staleArgs = {postId,_requestId:"mcp-delete-stale-preview"};
    const stale = await invoke("content.posts.delete",staleArgs);
    const staleId = Object.keys(stale.inputRequests)[0]!;
    await pool.query('UPDATE "SocialPost" SET content=\'Changed after preview\',"updatedAt"=now() WHERE id=$1',[postId]);
    const changedPreview = await invoke("content.posts.delete",staleArgs,{requestState:stale.requestState,inputResponses:{[staleId]:{action:"accept",content:{decision:"confirm"}}}});
    assert.equal(changedPreview.structuredContent.code,"operation_review_conflict");
    assert.equal(await draftCount(),1,"content changed after the preview cannot be confirmed");
    const boundPreview = await invoke("content.actions.preview",{action:"content.posts.delete",input:{postId},requestId:"mcp-delete-approved"});
    assert.equal(boundPreview.structuredContent.state,"succeeded",JSON.stringify(boundPreview));
    assert.equal(await draftCount(),1,"the preview must not mutate content");
    const previewId = boundPreview.structuredContent.result.preview.previewId;
    const finalArgs = {postId,_previewId:previewId};
    const final = await invoke("content.posts.delete",finalArgs);
    const finalId = Object.keys(final.inputRequests)[0]!;
    const response = {requestState:final.requestState,inputResponses:{[finalId]:{action:"accept",content:{decision:"confirm"}}}};
    const accepted = await invoke("content.posts.delete",finalArgs,response);
    assert.equal(accepted.structuredContent.state,"succeeded",JSON.stringify(accepted));
    assert.equal(await draftCount(),0);
    assert.deepEqual((await invoke("content.posts.delete",finalArgs,response)).structuredContent,accepted.structuredContent,"a replay returns the durable receipt without another effect");
    const receipt = (await pool.query('SELECT state,"decisionSource" FROM "GrowthOperationReview" WHERE "requestKey"=$1',["mcp-delete-approved"])).rows[0];
    assert.deepEqual(receipt,{state:"succeeded",decisionSource:"mcp_form"});
  } finally {await app?.close();await fixture.close();}
});
