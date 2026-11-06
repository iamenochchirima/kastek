import {describe,expect,it} from "vitest";
import {crawlPage,crawlSummary,modelConnection} from "../src/product/mcp/projections";

describe("MCP projections",()=>{
 it("paginates crawl metadata without page text or URL query secrets",()=>{
  const crawl={id:"crawl",url:"https://example.test/?token=secret",state:"completed",total:2,completed:2,errorCode:null,importJobId:null,createdAt:new Date(0).toISOString(),pages:[{id:"one",url:"https://example.test/a?key=secret",title:"A",markdown:"private raw page"},{id:"two",url:"https://example.test/b?key=secret",title:"B",markdown:"more raw page"}]};
  expect(crawlSummary(crawl)).toMatchObject({state:"completed",total:2,completed:2});expect(crawlSummary(crawl)).not.toHaveProperty("pages");
  const first=crawlPage(crawl,0,1);expect(first.pages).toEqual([{id:"one",title:"A",url:"https://example.test/a"}]);expect(first.nextOffset).toBe(1);
  const second=crawlPage(crawl,1,1);expect(second.nextOffset).toBeNull();
  expect(JSON.stringify([first,second])).not.toMatch(/secret|raw page/);
 });
 it("keeps usable model handles without organization, owner or endpoint metadata",()=>{
  const value=modelConnection({id:"id",name:"Model",providerId:"provider",state:"active",verification:"saved",organizationId:"organization",createdBy:"owner",endpoint:"https://provider.test",protocol:"openai_chat_completions",revision:1,credentialRevision:1,custody:"user_supplied",createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()});
  expect(value).toEqual({id:"id",name:"Model",providerId:"provider",state:"active",verification:"saved"});
 });
});
