import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {PlatformError} from "../../contracts/contracts";

const single=new Set(["id","agentId","sourceId","revisionId","connectionId","crawlId","taskId","reviewId","deploymentId","importJobId","jobId","modelId","versionId","bindingId","snapshotId","organizationId","accountId"]);
const many=new Set(["sourceRevisionIds","connectedToolBindingIds","skillIds","pageIds"]);
const internal=/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9a-f]{64})$/i;
const handle=/^ref_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
type Scope={connectionId:string;organizationId:string};
const field=(key:string)=>key.replace(/_([a-z])/g,(_match,letter:string)=>letter.toUpperCase());

/** Published schemas must describe handles rather than requiring the backend UUID. */
export function referenceAwareSchema(value:unknown,key=""):unknown {
 key=field(key);
 if(Array.isArray(value))return value.map(item=>referenceAwareSchema(item,key));
 if(value&&typeof value==="object"){
  const result=Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([field])=>!(field==="format"&&(single.has(key)||many.has(key)))).map(([field,item])=>[field,referenceAwareSchema(item,field==="items"?key:field)]));
  if((single.has(key)||many.has(key))&&!result.description)result.description="Use the reference returned by an earlier tool call.";
  return result;
 }
 return value;
}

/** References are scoped routing handles, never authority; product operations reauthorize use. */
export async function projectMcpReferences(pool:Pool,scope:Scope,value:unknown):Promise<unknown>{
 const memo=new Map<string,string>();
 const visit=async(item:unknown,key:string):Promise<unknown>=>{
  key=field(key);
  if(typeof item==="string" && (single.has(key)||many.has(key)) && internal.test(item)){
   const cached=memo.get(item);if(cached)return cached;
   const id=randomUUID();const row=(await pool.query<{id:string}>(`INSERT INTO agents_platform.mcp_references(id,connection_id,organization_id,target,expires_at) VALUES($1,$2,$3,$4,now()+interval '30 days')
    ON CONFLICT(connection_id,organization_id,target) DO UPDATE SET id=CASE WHEN agents_platform.mcp_references.expires_at<=now() THEN EXCLUDED.id ELSE agents_platform.mcp_references.id END,expires_at=EXCLUDED.expires_at RETURNING id`,[id,scope.connectionId,scope.organizationId,item])).rows[0]!;
   const result=`ref_${row.id}`;memo.set(item,result);return result;
  }
  if(Array.isArray(item))return Promise.all(item.map(v=>visit(v,key)));
  if(item && typeof item==="object")return Object.fromEntries(await Promise.all(Object.entries(item).map(async([k,v])=>[k,await visit(v,k)])));
  return item;
 };
 return visit(value,"");
}

export async function resolveMcpReferences(pool:Pool,scope:Scope,value:unknown):Promise<unknown>{
 const visit=async(item:unknown,key:string):Promise<unknown>=>{
  key=field(key);
  if(typeof item==="string" && (single.has(key)||many.has(key)) && item.startsWith("ref_")){
   const match=handle.exec(item);if(!match)throw new PlatformError("REFERENCE_UNAVAILABLE",404,"Reference is unavailable; list the item again");
   const row=(await pool.query<{target:string}>("SELECT target FROM agents_platform.mcp_references WHERE id=$1 AND connection_id=$2 AND organization_id=$3 AND expires_at>now()",[match[1],scope.connectionId,scope.organizationId])).rows[0];
   if(!row)throw new PlatformError("REFERENCE_UNAVAILABLE",404,"Reference is unavailable; list the item again");return row.target;
  }
  if(Array.isArray(item))return Promise.all(item.map(v=>visit(v,key)));
  if(item&&typeof item==="object")return Object.fromEntries(await Promise.all(Object.entries(item).map(async([k,v])=>[k,await visit(v,k)])));
  return item;
 };
 return visit(value,"");
}
