import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { createProductBindings,registerProductAdapter,registerProductManifest } from "../src/capabilities/products/product-capabilities";
import { productModelResult } from "../src/execution/products/product-result";
import { growthContentReadAdapterManifest,growthContentReadModelProjections,growthHistoricalModelProjections,growthRetainedOperationHandlers,growthFullOperationAccessHandlers,growthFullOperationAdapterManifests,growthFullOperationHandlers } from "../src/adapters/products/growth-capability-manifests";
import { growthAgentPublication,growthAgentPublicationV9 } from "../../../growth/api/src/agents/manifest";

describe("trusted Growth content read model projection",()=>{
  it("keeps editing data while omitting publishing internals and preserving the native result",()=>{
    const adapter=registerProductAdapter(growthContentReadAdapterManifest,{handlers:growthFullOperationHandlers,
      accessReceiptHandlers:growthFullOperationAccessHandlers,modelProjections:growthContentReadModelProjections,invoke:async()=>({value:{}})});
    const manifest=registerProductManifest(growthAgentPublication.manifest);
    expect(manifest.adapter).toEqual(adapter);
    const binding=createProductBindings(manifest,randomUUID(),{originProduct:"growth",originTenantId:"growth-org",tenantId:"growth-org",mappingRef:"growth:org",policyRevision:"11"},["content.posts.get","content.posts.list"]);
    const post={id:"post-1",title:"Service update",content:"Current draft text",channels:["FACEBOOK"],status:"DRAFT",scheduled_for:null,published_at:null,updated_at:"2026-11-03T00:00:00.000Z",
      primary_channel_id:null,primaryChannel:null,prompt:"internal source prompt",metadata:{private:"omit"},
      variants:[{id:"variant-1",post_id:"post-1",platform:"FACEBOOK",content:"Platform copy",status:"DRAFT",ai_generated:true,metadata:{private:"omit"}}],
      media:[{id:"post-media-1",post_id:"post-1",asset_id:"asset-1",kind:"IMAGE",mime_type:"image/png",file_name:"image.png",width:320,height:240,duration_ms:null,sort_order:0,alt_text:"A bicycle",byte_size:"1024"}],
      publishJobs:[{id:"pending-job",channel_connection_id:null,platform:"FACEBOOK",status:"PENDING",error_message:null,deliverySnapshot:{private:"omit"}}]};
    const native={post},before=structuredClone(native);
    const single=productModelResult(binding[0]!,native,randomUUID(),"operation:single");
    expect(single).toEqual({post:{id:"post-1",title:"Service update",content:"Current draft text",channels:["FACEBOOK"],status:"DRAFT",scheduledFor:null,publishedAt:null,
      updatedAt:"2026-11-03T00:00:00.000Z",variants:[{platform:"FACEBOOK",content:"Platform copy",status:"DRAFT"}],
      media:[{assetId:"asset-1",kind:"IMAGE",mimeType:"image/png",altText:"A bicycle",sortOrder:0}]}});
    expect(JSON.stringify(single)).not.toContain("channel_connection_id");
    expect(JSON.stringify(single)).not.toContain("PENDING");
    expect(JSON.stringify(single)).not.toContain("pending-job");
    expect(native).toEqual(before);

    const list=productModelResult(binding[1]!,{posts:[post],pagination:{limit:20,cursor:0,nextCursor:null}},randomUUID(),"operation:list");
    expect(list).toMatchObject({posts:[{id:"post-1",content:"Current draft text",status:"DRAFT"}],pagination:{limit:20,cursor:0,nextCursor:null}});
    expect(JSON.stringify(list)).not.toContain("channel_connection_id");

    const retainedAdapterManifest=growthFullOperationAdapterManifests.find(value=>value.release==="5")!;
    const retainedAdapter=registerProductAdapter(retainedAdapterManifest,{handlers:growthRetainedOperationHandlers,
      accessReceiptHandlers:growthFullOperationAccessHandlers.filter(handler=>growthRetainedOperationHandlers.includes(handler)),modelProjections:Object.fromEntries(Object.entries(growthHistoricalModelProjections).filter(([handler])=>growthRetainedOperationHandlers.includes(handler))),invoke:async()=>({value:{}})});
    const retainedPublication=registerProductManifest(growthAgentPublicationV9.manifest);
    expect(retainedPublication.adapter).toEqual(retainedAdapter);
    const retainedBinding=createProductBindings(retainedPublication,randomUUID(),{originProduct:"growth",originTenantId:"growth-org",tenantId:"growth-org",mappingRef:"growth:org",policyRevision:"9"},["content.posts.get"])[0]!;
    expect(retainedBinding.adapter.release).toBe("5");
    const retainedView=productModelResult(retainedBinding,native,randomUUID(),"operation:retained");
    expect(JSON.stringify(retainedView)).not.toContain("channel_connection_id");
    expect(JSON.stringify(retainedView)).not.toContain("PENDING");
    expect(native).toEqual(before);
  });

  it("fails closed when a projected post no longer matches its installed shape",()=>{
    const adapter=registerProductAdapter(growthContentReadAdapterManifest,{handlers:growthFullOperationHandlers,
      accessReceiptHandlers:growthFullOperationAccessHandlers,modelProjections:growthContentReadModelProjections,invoke:async()=>({value:{}})});
    registerProductManifest(growthAgentPublication.manifest);
    const binding=createProductBindings(growthAgentPublication.manifest,randomUUID(),{originProduct:"growth",originTenantId:"growth-org",tenantId:"growth-org",mappingRef:"growth:org",policyRevision:"11"},["content.posts.get"])[0]!;
    expect(binding.adapter).toEqual(adapter);
    expect(()=>productModelResult(binding,{post:{id:"post-1",publishJobs:[{channel_connection_id:null,status:"PENDING"}]}},randomUUID(),"operation"))
      .toThrowError(expect.objectContaining({code:"PRODUCT_PROJECTION_UNAVAILABLE"}));
  });
});
