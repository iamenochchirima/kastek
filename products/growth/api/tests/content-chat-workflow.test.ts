import test from "node:test";
import assert from "node:assert/strict";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import pg from "pg";
import {isolatedDatabase} from "./helpers/database-fixture.js";
import {installPgTimestampParsers} from "../src/db.js";
import {readConfig} from "../src/config.js";
import type {RequestContext} from "../src/identity/request-context.js";
import type {ProductCapabilityInvocation} from "@kasitek-labs/contracts";
import {executeGrowthOperation,confirmContentOperationReview,rejectContentOperationReview,getOperationReview,decideOperationReview} from "../src/operations/reviews.js";
import {invokeInternalGrowthOperation} from "../src/operations/internal.js";
import {contentActionNames} from "../src/operations/content-preview.js";

const database=process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("content agent drafts, immutable previews and protocol confirmation preserve exact authority and receipts",{skip:!database,timeout:60000},async t=>{
  installPgTimestampParsers();
  const inventory=new pg.Pool({connectionString:database});
  const tables=(await inventory.query<{tablename:string}>(`SELECT tablename FROM pg_tables WHERE schemaname='public'`)).rows.map(row=>row.tablename).filter(name=>/^[A-Za-z_]+$/.test(name)&&!["GrowthOperationReview","GrowthMediaTransfer"].includes(name)&&!name.startsWith("GrowthOAuth")&&name!=="analytics_outbox");
  await inventory.end();
  const fixture=await isolatedDatabase(database!,"content_chat",tables),pool=fixture.pool;
  const storage=await mkdtemp(join(tmpdir(),"content-chat-"));
  const core={pool,config:readConfig({DATABASE_URL:database!,ENVIRONMENT:"test",FRONTEND_URL:"http://localhost:3002",KASITEK_CORE_PUBLIC_URL:"http://localhost:4000",GROWTH_AGENT_ACCESS_ENABLED:"true",GROWTH_AGENT_EFFECTS_ENABLED:"true",KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE:"5000",KASITEK_MEDIA_STORAGE_PATH:storage,SOCIAL_TOKEN_ENCRYPTION_KEY:"fixture-content-chat"})};
  const context:RequestContext={principal:{kind:"trusted_internal_service",id:"content-fixture",subjectUserId:"alice",clientId:"fixture"},organizationId:"org-a",userId:"alice",clientId:"fixture",effectiveGrants:new Set(),apiScopes:new Set(["growth:read","growth:draft","growth:publish","growth:manage"]),correlationId:null,causationId:null,idempotencyKey:null};
  const call=(operation:string,input:Record<string,unknown>,requestId?:string,reviewId?:string,extra={})=>executeGrowthOperation(core,context,{operation,input,requestId,reviewId,...extra}) as Promise<Record<string,any>>;
  let postId="",assetId="";
  try{
    await pool.query('ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]');
    // Match the production SQL migration; Prisma's @updatedAt alone does not add a database default.
    await pool.query('ALTER TABLE "SocialPostMedia" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP');
    await pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql",import.meta.url),"utf8"));
    for(const name of ["20261101130000_growth_oauth.sql","20261101140000_growth_operation_reviews.sql","20261101150000_growth_media_transfers.sql","20261102190000_content_agent_workflows.sql"]) await pool.query(await readFile(new URL(`../sql/${name}`,import.meta.url),"utf8"));
    await pool.query(`INSERT INTO "User"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('alice','Alice','alice@example.test',NOW(),NOW(),NOW()),('bob','Bob','bob@example.test',NOW(),NOW(),NOW());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org-a','Business','content-chat-a','alice',NOW(),NOW()),('org-b','Other','content-chat-b','bob',NOW(),NOW());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org-a','alice','OWNER',NOW()),('member-b','org-b','bob','OWNER',NOW());
      INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId",metadata,"updatedAt") VALUES('facebook','alice','org-a','FACEBOOK','CONNECTED','Exact Page','page-one','{"permissions":["pages_manage_posts"],"permissionsInspected":true}',NOW()),('threads','alice','org-a','THREADS','CONNECTED','Thread profile','profile-two','{"scope":["threads_content_publish"],"permissionsInspected":true}',NOW());`);
    const draft={content:"Base copy",channels:["FACEBOOK","THREADS"],channelSelections:{FACEBOOK:"facebook",THREADS:"threads"},variants:[{platform:"FACEBOOK",content:"Facebook exact copy"},{platform:"THREADS",content:"Threads exact copy"}]};
    await t.test("requested draft create and concurrent retries save one receipt and one post",async()=>{
      const results=await Promise.all([call("content.posts.draft.create",{draft},"same-content-draft"),call("content.posts.draft.create",{draft},"same-content-draft")]);
      const saved=results.find(result=>result.state==="succeeded")!;assert.ok(saved,JSON.stringify(results));
      postId=saved.result.post.id;
      const replay=await call("content.posts.draft.create",{draft},"same-content-draft");
      assert.equal(replay.state,"succeeded");assert.equal(replay.result.post.id,postId);
      assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count,"1");
      const row=await getOperationReview(core,context,saved.review.id);assert.equal(row.decisionSource,"requested_draft");
      const events=(await pool.query(`SELECT record_id FROM analytics_outbox WHERE record_id=$1`,[`growth-access:operation:${row.id}:approved`])).rows;
      assert.equal(events.length,0,"requested draft must not fabricate human approval");
      await assert.rejects(call("content.posts.draft.create",{draft:{...draft,content:"different"}},"same-content-draft"),/different content/);
    });
    await t.test("lost acknowledgement reconciles an existing saved draft without repeating creation",async()=>{
      const saved=await call("content.posts.draft.create",{draft},"lost-acknowledgement");
      await pool.query(`UPDATE "GrowthOperationReview" SET state='uncertain',result=NULL WHERE id=$1`,[saved.review.id]);
      const result=await call("content.posts.draft.create",{draft},"lost-acknowledgement");
      assert.equal(result.state,"succeeded");assert.equal(result.result.postId,saved.result.post.id);assert.equal(result.result.reconciled,true);
      assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count,"2");
    });
    await t.test("requested media, draft edits and duplication execute directly with durable receipts",async()=>{
      const image="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4y8AAAAASUVORK5CYII=";
      const upload=await call("content.media.upload",{base64:image,mimeType:"image/png",fileName:"exact.png"},"upload-one-image");
      assert.equal(upload.state,"succeeded");assetId=upload.result.asset.id;
      const updated=await call("content.posts.draft.update",{postId,draft:{content:"Edited base copy",variants:draft.variants,media:[{assetId,altText:"Exact alt text",sortOrder:0}]}},"update-private-draft");
      assert.equal(updated.state,"succeeded");assert.equal(updated.result.post.content,"Edited base copy");
      assert.deepEqual(updated.result.post.publishJobs.map((job:any)=>job.channel_connection_id).sort(),["facebook","threads"]);
      const copy=await call("content.posts.duplicate",{postId},"duplicate-private-draft");
      assert.equal(copy.state,"succeeded");assert.notEqual(copy.result.post.id,postId);
      assert.equal((await getOperationReview(core,context,copy.review.id)).decisionSource,"requested_draft");
      const cleared=await call("content.posts.draft.update",{postId:copy.result.post.id,draft:{channelSelections:{}}},"explicit-clear-draft");
      assert.ok(cleared.result.post.publishJobs.every((job:any)=>job.channel_connection_id===null));
      const transfer=await call("content.media.transfer.prepare",{mimeType:"video/mp4",byteSize:256,fileName:"private.mp4"},"prepare-private-transfer");
      assert.equal(transfer.state,"succeeded");
      const transferReplay=await call("content.media.transfer.prepare",{mimeType:"video/mp4",byteSize:256,fileName:"private.mp4"},"prepare-private-transfer");
      assert.deepEqual(transferReplay.result,transfer.result);
    });
    await t.test("preview is platform exact and does not synchronize connections or mutate content",async()=>{
      const before=(await pool.query('SELECT "updatedAt",content FROM "SocialPost" WHERE id=$1',[postId])).rows[0];
      assert.equal((await pool.query('SELECT count(*) FROM "ExternalConnection"')).rows[0].count,"0");
      const response=await call("content.actions.preview",{action:"content.posts.publish",input:{postId,platform:"FACEBOOK"},requestId:"one-platform-preview"});
      const view=response.result.preview;assert.ok(view.previewId);assert.equal(view.operation,"content.posts.publish");
      assert.equal(view.preview.content,"Facebook exact copy");assert.deepEqual(view.preview.targets.map((target:any)=>target.platform),["FACEBOOK"]);
      assert.deepEqual(view.preview.accounts.map((account:any)=>account.id),["facebook"]);assert.equal(view.preview.media[0].altText,"Exact alt text");
      assert.equal((await pool.query('SELECT count(*) FROM "ExternalConnection"')).rows[0].count,"0");
      assert.deepEqual((await pool.query('SELECT "updatedAt",content FROM "SocialPost" WHERE id=$1',[postId])).rows[0],before);
      await assert.rejects(call("content.posts.publish",{postId,platform:"THREADS"},undefined,view.previewId),/different content/);
      const foreign={...context,principal:{...context.principal,id:"different-connection"}};
      await assert.rejects(getOperationReview(core,foreign,view.previewId),/not found/);
      await pool.query('UPDATE "SocialPost" SET content=\'Changed\',"updatedAt"=NOW() WHERE id=$1',[postId]);
      await assert.rejects(confirmContentOperationReview(core,context,view.previewId,view.payloadDigest,"mcp_form"),/changed/);
    });
    await t.test("all public content shapes have bounded previews with exact schedule and published edit changes",async()=>{
      const job=(await pool.query('SELECT id FROM "SocialPublishJob" WHERE "postId"=$1 ORDER BY id LIMIT 1',[postId])).rows[0].id;
      await pool.query(`INSERT INTO "SocialPublishBatch"(id,"userId","orgId","postId","idempotencyKey","snapshotHash",status,"targetCount","updatedAt") VALUES('batch','alice','org-a',$1,'batch-fixture','fixture','FAILED',1,NOW())`,[postId]);
      await pool.query(`INSERT INTO "SocialPublishBatchItem"(id,"batchId","jobId",platform,status,retryable,"updatedAt") SELECT 'item','batch',id,platform,'FAILED',true,NOW() FROM "SocialPublishJob" WHERE id=$1`,[job]);
      const schedule=new Date(Date.now()+3600000).toISOString();
      for(const action of contentActionNames){
        const input=action.startsWith("content.jobs.")?{jobId:job}:action==="content.posts.publish_batch.retry"?{batchId:"batch"}:{postId,...(["content.posts.publish","content.posts.delete_published"].includes(action)?{platform:"FACEBOOK"}:{}),...(["content.posts.schedule","content.posts.reschedule"].includes(action)?{scheduledFor:schedule}:{}),...(action==="content.posts.update_published"?{content:"New exact caption",expectedUpdatedAt:(await pool.query('SELECT "updatedAt" FROM "SocialPost" WHERE id=$1',[postId])).rows[0].updatedAt.toISOString(),removePhoto:true}:{})};
        const result=await call("content.actions.preview",{action,input,requestId:`preview-shape:${action}`});const view=result.result.preview;
        assert.equal(view.operation,action);assert.equal(view.preview.action,action);assert.ok(Array.isArray(view.preview.validation.errors));
        if(action==="content.posts.schedule")assert.equal(view.preview.requestedScheduledFor,schedule);
        if(action==="content.posts.update_published"){assert.equal(view.preview.content,"New exact caption");assert.equal(view.preview.removePhoto,true);assert.deepEqual(view.preview.media,[]);assert.equal(view.preview.removedMedia[0].assetId,assetId);}
      }
    });
    await t.test("revoked or narrowed credentials cannot consume an existing preview",async()=>{
      await pool.query(`INSERT INTO "DeveloperApiKey"(id,"orgId",name,prefix,"keyHash",scopes,status,"createdById","updatedAt") VALUES('key','org-a','Fixture','test','unused',ARRAY['growth:read','growth:manage'],'ACTIVE','alice',NOW())`);
      const keyed:RequestContext={...context,principal:{kind:"workspace_api_key",id:"key",subjectUserId:"alice",clientId:"key"},apiScopes:new Set(["growth:read","growth:manage"])};
      const response=await executeGrowthOperation(core,keyed,{operation:"content.actions.preview",input:{action:"content.posts.delete",input:{postId},requestId:"key-delete-preview"}}) as any;
      await pool.query(`UPDATE "DeveloperApiKey" SET scopes=ARRAY['growth:read'] WHERE id='key'`);
      await assert.rejects(confirmContentOperationReview(core,keyed,response.result.preview.previewId,response.result.preview.payloadDigest,"mcp_form"),/does not permit/);
    });
    await t.test("long previews continue using one stable preview without changing content",async()=>{
      const long="A".repeat(12000);
      await call("content.posts.draft.update",{postId,draft:{content:long,variants:[{platform:"FACEBOOK",content:long},{platform:"THREADS",content:"Short"}]}},"long-preview-draft");
      const input={action:"content.posts.publish",input:{postId,platform:"FACEBOOK"},requestId:"long-preview-stable"};
      const before=(await pool.query('SELECT count(*) FROM "GrowthOperationReview" WHERE "requestKey"=$1',[input.requestId])).rows[0].count;
      assert.equal(before,"0");
      let response=await call("content.actions.preview",input),assembled="",next:string|null=null;
      assert.equal(response.result.encoding,"json");
      do{assembled+=response.result.chunk;next=response.result.continuation;if(next)response=await call("content.actions.preview",input,undefined,undefined,{continuation:next});}while(next);
      const parsed=JSON.parse(assembled);assert.equal(parsed.result.preview.preview.content,long);
      assert.equal((await pool.query('SELECT count(*) FROM "GrowthOperationReview" WHERE "requestKey"=$1',[input.requestId])).rows[0].count,"1");
      assert.equal((await pool.query('SELECT content FROM "SocialPost" WHERE id=$1',[postId])).rows[0].content,long);
    });
    await t.test("every platform preview selects only its saved account and exact variant",async()=>{
      const platforms=["FACEBOOK","INSTAGRAM","THREADS","TIKTOK","LINKEDIN","X","BLUESKY"];
      const selections:Record<string,string>={FACEBOOK:"facebook",THREADS:"threads"};
      for(const platform of platforms.filter(value=>!selections[value])){
        const id=`account-${platform}`;selections[platform]=id;
        await pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId",metadata,"updatedAt") VALUES($1,'alice','org-a',$2::"SocialPlatform",'CONNECTED',$2::text,$1,'{}',NOW())`,[id,platform]);
      }
      const created=await call("content.posts.draft.create",{draft:{content:"Shared",channels:platforms,channelSelections:selections,variants:platforms.map(platform=>({platform,content:`Exact ${platform}`}))}},"all-platform-preview-draft");
      const allPostId=(await pool.query('SELECT result FROM "GrowthOperationReview" WHERE "requestKey"=$1',["all-platform-preview-draft"])).rows[0].result.post.id;
      for(const platform of platforms){
        const response=await call("content.actions.preview",{action:"content.posts.publish",input:{postId:allPostId,platform},requestId:`only-${platform}-preview`});
        const preview=response.result.preview.preview;
        assert.equal(preview.content,`Exact ${platform}`);
        assert.deepEqual(preview.accounts.map((account:any)=>account.id),[selections[platform]]);
        assert.deepEqual(preview.targets.map((target:any)=>target.platform),[platform]);
      }
    });
    await t.test("internal preview prepares a distinct task-bound review and UI approval commits its exact action",async()=>{
      const command={operation:"content.posts.draft.create",control:"invoke",input:{draft:{content:"Task-specific draft",channels:["FACEBOOK"],channelSelections:{FACEBOOK:"facebook"}}},actor:{subject:"alice"},authority:{tenantId:"org-a",policyRevision:"9"},operationId:"parity-draft",requestId:"parity-call",taskId:"d31ca63f-9a25-47fa-8b3c-ad4795126eac",conversationId:"e51ca63f-9a25-47fa-8b3c-ad4795126eac"} as ProductCapabilityInvocation;
      const created=await invokeInternalGrowthOperation(core,command);
      const jobId=(created.value as any).result.post.publishJobs[0].id;
      const previewCommand={...command,operation:"content.actions.preview",operationId:"parity-preview",input:{action:"content.jobs.cancel",input:{jobId},requestId:"parity-preview-key"}};
      const artifact=await invokeInternalGrowthOperation(core,previewCommand);
      const preview=(artifact.value as any).result.preview;
      const action={...command,operation:"content.jobs.cancel",control:"prepare" as const,operationId:"parity-action",input:{jobId,_previewId:preview.previewId}};
      await assert.rejects(invokeInternalGrowthOperation(core,{...action,taskId:"different-task"}),/another task or conversation/);
      await assert.rejects(invokeInternalGrowthOperation(core,{...action,conversationId:"different-chat"}),/another task or conversation/);
      const prepared=await invokeInternalGrowthOperation(core,action);
      assert.notEqual(prepared.review!.id,preview.previewId);assert.equal(prepared.review!.taskId,command.taskId);assert.equal(prepared.review!.operationId,action.operationId);
      assert.equal(prepared.review!.state,"proposed");
      const repeated=await invokeInternalGrowthOperation(core,action);assert.equal(repeated.review!.id,prepared.review!.id);
      const internal=await import("../src/operations/internal.js");const internalContext=internal.internalOperationContext(command);
      const unbound=await executeGrowthOperation(core,internalContext,{operation:"content.actions.preview",input:{action:"content.jobs.cancel",input:{jobId},requestId:"public-unbound-preview"}}) as any;
      await assert.rejects(invokeInternalGrowthOperation(core,{...action,operationId:"borrow-unbound",input:{jobId,_previewId:unbound.result.preview.previewId}}),/another task or conversation/);
      assert.equal((await pool.query('SELECT status FROM "SocialPublishJob" WHERE id=$1',[jobId])).rows[0].status,"PENDING");
      const human:RequestContext={...internalContext,principal:{kind:"direct_user",id:"alice",subjectUserId:"alice",clientId:"growth"}};
      await decideOperationReview(core,human,prepared.review!.id,"approve",prepared.review!.payloadDigest);
      await assert.rejects(invokeInternalGrowthOperation(core,{...action,control:"commit",conversationId:"different-chat",input:{},review:prepared.review}),/another operation/);
      const committed=await invokeInternalGrowthOperation(core,{...action,control:"commit",input:{},review:prepared.review});
      assert.equal(committed.receipt!.state,"saved");assert.equal(committed.receipt!.operationId,action.operationId);
      assert.equal((await pool.query('SELECT status FROM "SocialPublishJob" WHERE id=$1',[jobId])).rows[0].status,"CANCELED");
      assert.equal((await getOperationReview(core,internalContext,preview.previewId)).state,"proposed","source preview approval is never borrowed or reassigned");
      await assert.rejects(invokeInternalGrowthOperation(core,{...action,operationId:"stale-action"}),/changed/);
    });
    await t.test("current internal drafts return exact receipts; status recovery never admits a missing write",async()=>{
      const command={operation:"content.posts.draft.create",control:"invoke",input:{draft},actor:{subject:"alice"},authority:{tenantId:"org-a",policyRevision:"9"},operationId:"new-internal-draft",requestId:"internal-call",taskId:"task",conversationId:"chat"} as ProductCapabilityInvocation;
      const first=await invokeInternalGrowthOperation(core,command);assert.equal(first.receipt?.state,"saved");
      const status=await invokeInternalGrowthOperation(core,{...command,control:"review"});assert.deepEqual(status.receipt,first.receipt);
      const count=(await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count;
      const missing=await invokeInternalGrowthOperation(core,{...command,operationId:"never-admitted-draft",control:"review"});assert.equal(missing.receipt,undefined);
      assert.equal((await pool.query('SELECT count(*) FROM "SocialPost"')).rows[0].count,count);
      const retained=await invokeInternalGrowthOperation(core,{...command,authority:{...command.authority,policyRevision:"8"},operationId:"old-reviewed-draft",control:"prepare"});
      assert.equal(retained.review?.state,"proposed");
      const premature=await invokeInternalGrowthOperation(core,{...command,authority:{...command.authority,policyRevision:"8"},operationId:"old-reviewed-draft",control:"commit",review:retained.review});assert.equal(premature.receipt,undefined);
      assert.equal((premature.value as any).state,"approval_required");
      const staging=await invokeInternalGrowthOperation(core,{...command,operation:"content.media.transfer.prepare",input:{mimeType:"video/mp4",byteSize:128},authority:{...command.authority,policyRevision:"8"},operationId:"retained-transfer-prepare"});
      assert.equal((staging.value as any).state,"succeeded");assert.equal(staging.receipt?.state,"saved");
      assert.ok((staging.value as any).result.transferId);
    });
  }finally{await fixture.close();await rm(storage,{recursive:true,force:true});}
});
