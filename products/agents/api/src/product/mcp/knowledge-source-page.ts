import { z } from "zod";
import type { KnowledgeStore } from "../../platform/knowledge";

/** Offsets count Unicode code points, so pages do not split surrogate pairs. */
export async function readKnowledgeSourcePage(knowledge:KnowledgeStore,scope:{accountId:string;organizationId:string},raw:unknown) {
  const input=z.strictObject({sourceId:z.uuid(),revisionId:z.uuid(),offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(8192).default(6000)}).parse(raw);
  const source=await knowledge.preview(scope,input.sourceId,input.revisionId);
  const points=Array.from(source.text);
  const offset=Math.min(input.offset,points.length),end=Math.min(offset+input.limit,points.length);
  return {revisionId:input.revisionId,revision:source.revision,acquiredAt:source.acquiredAt,text:points.slice(offset,end).join(""),
    offset,nextOffset:end<points.length?end:null,truncated:end<points.length};
}
