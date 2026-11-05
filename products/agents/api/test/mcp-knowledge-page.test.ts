import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import type { KnowledgeStore } from "../src/capabilities/knowledge/knowledge";
import { readKnowledgeSourcePage } from "../src/product/mcp/knowledge-source-page";

describe("MCP knowledge pages",()=>{
 it("preserves Unicode boundaries and rechecks source access on every page",async()=>{
  const sourceId=randomUUID(),revisionId=randomUUID(),scope={accountId:randomUUID(),organizationId:randomUUID()};
  let authorized=true,calls=0;
  const knowledge={preview:async(s:typeof scope,source:string,revision:string)=>{calls++;expect(s).toEqual(scope);expect(source).toBe(sourceId);expect(revision).toBe(revisionId);if(!authorized)throw Error("revoked");return {text:"A😀BC",revision:2,acquiredAt:"2026-11-03T00:00:00.000Z"};}} as unknown as KnowledgeStore;
  const first=await readKnowledgeSourcePage(knowledge,scope,{sourceId,revisionId,limit:2});
  expect(first).toMatchObject({text:"A😀",offset:0,nextOffset:2,truncated:true});
  const second=await readKnowledgeSourcePage(knowledge,scope,{sourceId,revisionId,limit:2,offset:first.nextOffset});
  expect(second).toMatchObject({text:"BC",offset:2,nextOffset:null,truncated:false});
  authorized=false;await expect(readKnowledgeSourcePage(knowledge,scope,{sourceId,revisionId,offset:2})).rejects.toThrow("revoked");expect(calls).toBe(3);
 });
});
