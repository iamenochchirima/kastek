import test from "node:test";
import type { ProductCapabilityInvocation } from "@kasitek-labs/contracts";
import { invokeInternalGrowthOperation } from "../src/operations/internal.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { contentLibraryFixture } from "./helpers/content-library-fixture.js";
import { CORE_REGISTRARS } from "../src/main.js";
import { MCP_2026_VERSION } from "../src/operations/mcp-2026.js";
const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL ?? process.env.CORE_SOCIAL_TEST_DATABASE_URL;

test("a real MP4 uploaded through MCP previews and reuses one stored asset in independent drafts", {skip: !database, timeout: 30000}, async () => {
  const fixture = await contentLibraryFixture(database!, {registrars: CORE_REGISTRARS});
  const bytes = await readFile(new URL("./fixtures/content-library-video.mp4", import.meta.url));
  let rpc = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fixture.app.inject({method:"POST",url:"/mcp",headers:{host:"localhost:4105",authorization:"Bearer "+fixture.token,"mcp-protocol-version":MCP_2026_VERSION,"mcp-method":"tools/call","mcp-name":name},payload:{jsonrpc:"2.0",id:++rpc,method:"tools/call",params:{name,arguments:args,_meta:{"io.modelcontextprotocol/protocolVersion":MCP_2026_VERSION,"io.modelcontextprotocol/clientCapabilities":{}}}}});
    assert.equal(response.statusCode,200,response.body);
    const result=response.json().result;
    assert.ok(!result.isError,JSON.stringify(result));
    assert.equal(result.structuredContent.state,"succeeded",JSON.stringify(result));
    return result.structuredContent.result;
  };
  try {
    const upload={fileName:"Library video.mp4",mimeType:"video/mp4",base64:bytes.toString("base64"),_requestId:"library-video-upload"};
    const saved=await call("content.media.upload",upload);
    assert.equal(saved.asset.kind,"VIDEO");
    assert.equal((await call("content.media.upload",upload)).asset.id,saved.asset.id);
    const listed=await call("content.media.list",{kind:"VIDEO"});
    assert.deepEqual(listed.assets.map((asset:{id:string})=>asset.id),[saved.asset.id]);
    const apiRead=await fixture.app.inject({method:"POST",url:"/v1/operations/content.media.get",headers:{host:"localhost:4105",authorization:"Bearer "+fixture.apiKey},payload:{assetId:saved.asset.id}});
    assert.equal(apiRead.statusCode,200,apiRead.body);
    assert.equal(apiRead.json().result.asset.kind,"VIDEO");
    const apiEdit=await fixture.app.inject({method:"POST",url:"/v1/operations/content.media.update",headers:{host:"localhost:4105",authorization:"Bearer "+fixture.apiKey},payload:{assetId:saved.asset.id,expectedRevision:1,tags:["video-fixture"],_requestId:"library-video-api-edit"}});
    assert.equal(apiEdit.statusCode,200,apiEdit.body);
    assert.equal(apiEdit.json().result.asset.revision,2);
    const preview=await call("content.media.preview",{assetId:saved.asset.id});
    const url=new URL(preview.previewUrl);
    const response=await fixture.app.inject({method:"GET",url:url.pathname+url.search,headers:{host:"localhost:4105"}});
    assert.equal(response.statusCode,200,response.body);
    assert.match(String(response.headers["content-type"]),/video\/mp4/);
    assert.deepEqual(response.rawPayload,bytes);
    const first=await call("content.posts.draft.create",{draft:{content:"Video reuse fixture",channels:["TIKTOK"],media:[{assetId:saved.asset.id,altText:"Blue test frame"}]},_requestId:"library-video-draft"});
    const copied=await invokeInternalGrowthOperation(fixture,{operation:"content.posts.duplicate",input:{postId:first.post.id},operationId:"library-video-copy",requestId:"library-video-copy",control:"invoke",actor:{subject:"library-user"},authority:{tenantId:"library-org",policyRevision:"11"},taskId:"library-video-task",conversationId:"library-video-chat"} as ProductCapabilityInvocation);
    const second=(copied.value as {result:{post:typeof first.post}}).result;
    assert.notEqual(first.post.id,second.post.id);
    assert.equal(second.post.media[0].asset_id,saved.asset.id);
    assert.equal(second.post.media[0].alt_text,"Blue test frame");
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM "ContentMediaAsset" WHERE id=$1',[saved.asset.id])).rows[0].count,1);
    assert.equal((await fixture.pool.query('SELECT count(*)::int AS count FROM "SocialPostMedia" WHERE "assetId"=$1',[saved.asset.id])).rows[0].count,2);
  } finally {await fixture.close();}
});
