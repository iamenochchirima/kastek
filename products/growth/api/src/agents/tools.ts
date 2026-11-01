import { parseGrowthAgentContext,type GrowthAgentContext,type GrowthAgentContextEvidence } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { requireCapability } from "../services/billing.js";
import { listSocialPosts } from "../services/social/posts.js";
import { listCampaigns } from "../services/whatsapp/campaigns.js";
import { growthAgentDigest } from "./security.js";
import { authorizeGrowthAgentScope, readGrowthAgentContext, type GrowthAgentScope } from "./scope.js";

export interface GrowthToolPage { search?: string; status?: string; limit?: number; cursor?: string }
const PAGE_LIMIT = 20;
const READ_CHARACTERS = 6000;
const bad = () => new ApiError(400, "agent_tool_arguments_invalid", "Check the tool arguments");
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad();
  return input as Record<string, unknown>;
}
function page(input: unknown) {
  const value=object(input);
  if(Object.keys(value).some(k=>!["search","status","limit","cursor"].includes(k)))throw bad();
  if(value.search!==undefined&&(typeof value.search!=="string"||value.search.length>200))throw bad();
  if(value.status!==undefined&&(typeof value.status!=="string"||value.status!==""&&!/^[_A-Z]{1,40}$/.test(value.status)))throw bad();
  const limit=value.limit??PAGE_LIMIT;
  if(typeof limit!=="number"||!Number.isSafeInteger(limit)||limit<1||limit>PAGE_LIMIT)throw bad();
  if(value.cursor!==undefined&&(typeof value.cursor!=="string"||value.cursor.length>2048))throw bad();
  // Empty optional filters select the unfiltered page allowed by the published schema.
  const filters={...(value.search===undefined||value.search===""?{}:{search:value.search as string}),...(value.status===undefined||value.status===""?{}:{status:value.status as string})};
  return {limit,filters,cursor:value.cursor as string|undefined};
}
function encode(value:unknown){return Buffer.from(JSON.stringify(value)).toString("base64url");}
function decode(cursor:string){try{return object(JSON.parse(Buffer.from(cursor,"base64url").toString("utf8")));}catch{throw bad();}}
function after(cursor:string|undefined,scope:GrowthAgentScope,kind:string,filters:unknown) {
  if(!cursor)return undefined;
  const value=decode(cursor);
  if(value.scope!==growthAgentDigest({tenantId:scope.tenantId,actor:scope.actor,kind,filters})||typeof value.id!=="string"||value.id.length>256)throw bad();
  return value.id;
}
export async function discoverGrowthRecords(core:CoreContext,scope:GrowthAgentScope,kind:"content_post"|"whatsapp_campaign",input:unknown) {
  await authorizeGrowthAgentScope(core,scope);
  await requireCapability(core.pool,scope.tenantId,kind==="content_post"?"feature.content.manage":"feature.campaigns.manage");
  const parsed=page(input),options={...parsed.filters,limit:parsed.limit+1,afterId:after(parsed.cursor,scope,kind,parsed.filters)};
  const records=kind==="content_post"?await listSocialPosts(core.pool,scope.tenantId,options):
    (await listCampaigns(core.pool,scope.tenantId,options)).campaigns as Record<string,unknown>[];
  const selected:{id:unknown}[]=[];
  const items:{context:GrowthAgentContext;title:string;status:unknown;route:string;revision:string}[]=[];
  for(const record of records.slice(0,parsed.limit)) {
    const context:GrowthAgentContext={kind,resourceId:String(record.id)};
    const evidence=await readGrowthAgentContext(core,scope,context);
    const item={context,title:String("title"in record?record.title??"Content draft":record.name??"WhatsApp campaign").slice(0,160),
      status:record.status,route:kind==="content_post"?`/content/posts/${encodeURIComponent(String(record.id))}`:`/campaigns/${encodeURIComponent(String(record.id))}`,revision:evidence.revision};
    // Leave room for citation passages in the installed 8 KiB model-result envelope.
    if(items.length&&Buffer.byteLength(JSON.stringify([...items,item]))>2500)break;
    selected.push({id:record.id});items.push(item);
  }
  return {items,nextCursor:records.length>selected.length?encode({scope:growthAgentDigest({tenantId:scope.tenantId,actor:scope.actor,kind,filters:parsed.filters}),id:selected.at(-1)!.id}):null};
}
export async function readGrowthRecord(core:CoreContext,scope:GrowthAgentScope,context:GrowthAgentContext,input:unknown):Promise<GrowthAgentContextEvidence & {continuation:string|null}> {
  const value=object(input);
  if(Object.keys(value).some(k=>!["resourceId","range","report","continuation"].includes(k)))throw bad();
  if(value.continuation!==undefined&&(typeof value.continuation!=="string"||value.continuation.length>2048))throw bad();
  const response=await readGrowthAgentContext(core,scope,context);
  const full=JSON.stringify(response.data);let offset=0;
  // Published capability schemas allow an empty continuation for the initial page.
  if(typeof value.continuation==="string"&&value.continuation.length>0){
    const cursor=decode(value.continuation);
    if(cursor.scope!==growthAgentDigest({tenantId:scope.tenantId,actor:scope.actor,context})||cursor.revision!==response.revision||typeof cursor.offset!=="number"||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>=full.length)throw new ApiError(409,"agent_source_changed","The source changed. Read it again");
    offset=cursor.offset;
  }
  // Chunks are JSON text fragments. The source revision covers the entire record, not this chunk.
  let end=Math.min(full.length,offset+READ_CHARACTERS);
  while(end>offset+1&&Buffer.byteLength(JSON.stringify({text:full.slice(offset,end)}))>2500)end=offset+Math.floor((end-offset)/2);
  if(end<full.length&&/[\uD800-\uDBFF]/.test(full[end-1]!))end--;
  const continuation=end<full.length?encode({scope:growthAgentDigest({tenantId:scope.tenantId,actor:scope.actor,context}),revision:response.revision,offset:end}):null;
  return {...response,data:{format:"json_text",offset,text:full.slice(offset,end),complete:continuation===null},continuation};
}

export async function growthSourceHandle(core:CoreContext,scope:GrowthAgentScope,context:GrowthAgentContext):Promise<string> {
  const id="growth-resource:"+growthAgentDigest({scope,context});
  await core.pool.query(`INSERT INTO "GrowthAgentSourceHandle"(id,"orgId","actorId","actorIssuer",context)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[id,scope.tenantId,scope.actor.subject,scope.actor.issuer,context]);
  return id;
}
export async function resolveGrowthSourceHandle(core:CoreContext,scope:GrowthAgentScope,id:unknown):Promise<GrowthAgentContext> {
  if(typeof id!=="string"||!/^growth-resource:[a-f0-9]{64}$/.test(id))throw new ApiError(403,"agent_source_denied","The source is unavailable");
  const row=(await core.pool.query('SELECT context FROM "GrowthAgentSourceHandle" WHERE id=$1 AND "orgId"=$2 AND "actorId"=$3 AND "actorIssuer"=$4',
    [id,scope.tenantId,scope.actor.subject,scope.actor.issuer])).rows[0];
  if(!row||id!=="growth-resource:"+growthAgentDigest({scope,context:row.context}))throw new ApiError(403,"agent_source_denied","The source is unavailable");
  return parseGrowthAgentContext(row.context);
}
