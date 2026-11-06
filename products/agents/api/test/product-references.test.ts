import { describe, expect, it } from "vitest";
import { growthProductReferences } from "../src/adapters/products/growth-capability-manifests";
import { projectReferenceFields, resolveReferenceFields } from "../src/execution/products/product-references";

describe("shared product reference projections",()=>{
  it("replaces only adapter-declared account selectors while retaining names and public handles",async()=>{
    const native={value:{state:"succeeded",result:{accounts:[
      {id:"social-account-database-id",name:"KasiTek",handle:"@kasitek",platformAccountId:"public-page-id"},
    ]}}};
    const rules=growthProductReferences["growth.operation.content.accounts.list@1"];
    const projected=await projectReferenceFields(native,rules,async(rule,row)=>`${rule.resourceType}:${row.id}`) as typeof native;
    expect(projected.value.result.accounts[0]).toEqual({id:"growth.social_account:social-account-database-id",name:"KasiTek",handle:"@kasitek",platformAccountId:"public-page-id"});
    expect(native.value.result.accounts[0]?.id).toBe("social-account-database-id");
  });

  it("resolves nested channel selectors to native values and rejects a handle rejected by the adapter store",async()=>{
    const handle="aref_"+"A".repeat(43),native="native-account-id";
    const input={draft:{title:"Post",channelSelections:{FACEBOOK:handle},primaryChannelId:handle},userCopy:"@kasitek"};
    const rules=growthProductReferences["growth.operation.content.posts.draft.create@1"];
    const resolved=await resolveReferenceFields(input,rules,async(_rule,id)=>id===handle?native:Promise.reject(new Error("unknown reference")));
    expect(resolved).toEqual({draft:{title:"Post",channelSelections:{FACEBOOK:native},primaryChannelId:native},userCopy:"@kasitek"});
    expect(input.draft.channelSelections.FACEBOOK).toBe(handle);
    await expect(resolveReferenceFields(input,rules,async()=>Promise.reject(new Error("out of scope")))).rejects.toThrow("out of scope");
  });

  it("projects Growth post and media selectors while keeping titles, captions, and channel names",async()=>{
    const native={post:{id:"native-post-record-123456",title:"Monday launch",content:"Visit @kasitek",channels:["FACEBOOK"],media:[{assetId:"native-media-record-123456",kind:"IMAGE"}]}};
    const rules=growthProductReferences["growth.operation.content.posts.get@1"];
    const projected=await projectReferenceFields(native,rules,async(rule,row)=>`${rule.resourceType}:${row.id}`) as typeof native;
    expect(projected).toEqual({post:{id:"growth.content_post:native-post-record-123456",title:"Monday launch",content:"Visit @kasitek",channels:["FACEBOOK"],media:[{assetId:"growth.media_asset:native-media-record-123456",kind:"IMAGE"}]}});
    expect(native.post.id).toBe("native-post-record-123456");
    expect(native.post.media[0]?.assetId).toBe("native-media-record-123456");
  });

  it("binds connection selectors separately from social publishing accounts",()=>{
    expect(growthProductReferences["growth.operation.connections.status.update@1"][0]?.resourceType).toBe("growth.connection");
    expect(growthProductReferences["growth.operation.connections.list@1"][0]?.outputRows).toEqual(["value.result.connections.*"]);
    expect(growthProductReferences["growth.operation.content.posts.draft.create@1"][0]?.resourceType).toBe("growth.social_account");
    expect(growthProductReferences["growth.operation.content.accounts.list@1"][0]?.outputRows).toEqual(["value.result.accounts.*"]);
    expect(growthProductReferences["growth.operation.content.posts.get@1"][0]?.outputRows).toEqual(["post"]);
    expect(growthProductReferences["growth.operation.content.posts.get@1"][1]?.outputValues).toEqual(["post.media.*.assetId"]);
    expect(growthProductReferences["growth.operation.content.templates.instantiate@1"].find(rule=>rule.resourceType==="growth.social_account")?.inputPaths).toContain("channelSelections.*");
  });
});
