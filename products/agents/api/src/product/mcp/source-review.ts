import {randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {PlatformError} from "../../contracts/contracts";
import {KnowledgeStore,requireKnowledgeMember} from "../../platform/knowledge";
import {transaction} from "../../infrastructure/database";

type Scope={accountId:string;organizationId:string;connectionId:string};
type Row={id:string;organization_id:string;account_id:string;connection_id:string;source_id:string;revision_id:string|null;expected_generation:number;state:string;expired:boolean;title:string};
export class SourceReview {
 constructor(private readonly pool:Pool,private readonly knowledge:KnowledgeStore,private readonly publicUrl:string) {}
 private async row(db:Pool|PoolClient,accountId:string,id:string,lock=false){
  const row=(await db.query<Row>(`SELECT r.*,s.title,r.expires_at<=now() expired FROM agents_platform.mcp_source_reviews r JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id WHERE r.id=$1 AND r.account_id=$2 ${lock?"FOR UPDATE OF r":""}`,[z.uuid().parse(id),accountId])).rows[0];
  if(!row)throw new PlatformError("NOT_FOUND",404,"Review unavailable");await requireKnowledgeMember(db,{accountId,organizationId:row.organization_id},true);return row;
 }
 private dto(row:Row){return {id:row.id,sourceId:row.source_id,sourceTitle:row.title,revisionId:row.revision_id,state:row.state==="pending"&&row.expired?"expired":row.state,reviewUrl:new URL(`/app/mcp/source-review?request=${row.id}`,this.publicUrl).toString()};}
 async propose(scope:Scope,raw:unknown){
  const input=z.strictObject({sourceId:z.uuid(),requestId:z.uuid(),expectedGeneration:z.number().int().positive(),revisionId:z.uuid()}).parse(raw);
  return transaction(this.pool,async db=>{
   await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireKnowledgeMember(db,scope,true);
   const old=(await db.query<Row>(`SELECT r.*,s.title,r.expires_at<=now() expired FROM agents_platform.mcp_source_reviews r JOIN agents_platform.sources s ON s.id=r.source_id WHERE r.organization_id=$1 AND r.account_id=$2 AND r.request_id=$3`,[scope.organizationId,scope.accountId,input.requestId])).rows[0];
   if(old){if(old.connection_id!==scope.connectionId||old.source_id!==input.sourceId||old.expected_generation!==input.expectedGeneration||old.revision_id!==input.revisionId)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request identity conflict");return this.dto(old);}
   const source=(await db.query("SELECT title,generation,state FROM agents_platform.sources WHERE id=$1 AND organization_id=$2 FOR UPDATE",[input.sourceId,scope.organizationId])).rows[0];
   if(!source||source.state!=="active"||source.generation!==input.expectedGeneration)throw new PlatformError("SOURCE_POLICY_CONFLICT",409,"Source changed; refresh and try again");
   if(!(await db.query("SELECT 1 FROM agents_platform.source_revision_policy WHERE source_id=$1 AND revision_id=$2 AND organization_id=$3 AND state='candidate'",[input.sourceId,input.revisionId,scope.organizationId])).rowCount)throw new PlatformError("SOURCE_REVISION_UNAVAILABLE",409,"Select an available candidate revision");
   const id=randomUUID();await db.query("INSERT INTO agents_platform.mcp_source_reviews(id,request_id,organization_id,account_id,connection_id,source_id,revision_id,expected_generation,action) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'approve')",[id,input.requestId,scope.organizationId,scope.accountId,scope.connectionId,input.sourceId,input.revisionId,input.expectedGeneration]);return this.dto(await this.row(db,scope.accountId,id));
  });
 }
 private async preview(row:Row){
  if(!row.revision_id)return null;
  const source=await this.knowledge.preview({accountId:row.account_id,organizationId:row.organization_id},row.source_id,row.revision_id);
  const text=Array.from(source.text),limit=12000;
  return {revision:source.revision,excerpt:text.slice(0,limit).join(""),truncated:text.length>limit};
 }
 async get(accountId:string,id:string){
  const row=await this.row(this.pool,accountId,id);
  try {const preview=await this.preview(row);await this.row(this.pool,accountId,id);return {...this.dto(row),preview,previewUnavailable:false};}
  catch(error){if(error instanceof PlatformError){const current=await this.row(this.pool,accountId,id);return {...this.dto(current),preview:null,previewUnavailable:true};}throw error;}
 }
 async getForScope(scope:Scope,id:string){const row=await this.row(this.pool,scope.accountId,id);if(row.organization_id!==scope.organizationId)throw new PlatformError("NOT_FOUND",404,"Review unavailable");return this.dto(row);}
 async decide(accountId:string,id:string,approved:boolean){
  if(approved){const row=await this.row(this.pool,accountId,id);if(row.state==="pending")await this.preview(row);}
  return transaction(this.pool,async db=>{
  const row=await this.row(db,accountId,id,true);if(row.state!=="pending")return this.dto(row);if(row.expired)throw new PlatformError("REVIEW_EXPIRED",409,"Review expired");
  if(!approved){await db.query("UPDATE agents_platform.mcp_source_reviews SET state='cancelled' WHERE id=$1",[row.id]);return this.dto({...row,state:"cancelled"});}
  await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[row.organization_id]);
  if(!(await db.query("SELECT 1 FROM agents_platform.mcp_oauth_connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND revoked_at IS NULL AND 'agents:manage'=ANY(scopes) FOR SHARE",[row.connection_id,row.organization_id,accountId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"Connection access is unavailable");
  await this.knowledge.setPolicyInTransaction(db,{accountId,organizationId:row.organization_id},row.source_id,{operationId:`mcp-review:${row.id}`,expectedGeneration:row.expected_generation,action:"approve",...(row.revision_id?{revisionId:row.revision_id}:{})});
  await db.query("UPDATE agents_platform.mcp_source_reviews SET state='approved' WHERE id=$1",[row.id]);return this.dto({...row,state:"approved"});
 });}
}
