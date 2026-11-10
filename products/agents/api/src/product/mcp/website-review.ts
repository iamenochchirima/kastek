import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { normalizeWebsiteDomain, PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { DeploymentStore } from "../deployments/deployment-store";
import { defaultWebsiteAppearance, websiteAppearanceSchema } from "../../adapters/channels/website/appearance";

type Scope = { accountId:string; organizationId:string };
type Review = {id:string; organization_id:string; account_id:string; connection_id:string; agent_id:string; version_id:string; appearance_revision:number; allowed_origins:string[]; state:string; deployment_id:string|null; expired:boolean; agent_name:string; instructions:string; appearance:unknown; sources:{title:string;visibility:string;state:string}[]};
export class WebsiteReview {
 constructor(private readonly pool:Pool, private readonly publicUrl:string) {}
 private async membership(db:Pool|PoolClient,scope:Scope) {
  if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount) throw new PlatformError("ACCESS_DENIED",403,"Access denied");
 }
 private async row(db:Pool|PoolClient,accountId:string,id:string,lock=false):Promise<Review> {
  const row=(await db.query<Review>(`SELECT r.*,a.name agent_name,r.expires_at<=now() expired,v.configuration->>'instructions' instructions,d.appearance,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('title',CASE WHEN s.visibility='public' OR s.importer_account_id=$2 OR EXISTS (SELECT 1 FROM agents_platform.memberships m WHERE m.organization_id=r.organization_id AND m.account_id=$2 AND m.role IN ('owner','admin') AND m.revoked_at IS NULL) THEN s.title ELSE 'Private source' END,'visibility',s.visibility,'state',p.state) ORDER BY s.title) FROM agents_platform.version_sources vs JOIN agents_platform.sources s ON s.id=vs.source_id JOIN agents_platform.source_revision_policy p ON p.revision_id=vs.revision_id WHERE vs.version_id=r.version_id),'[]'::jsonb) sources
   FROM agents_platform.mcp_website_reviews r JOIN agents_platform.agents a ON a.id=r.agent_id AND a.organization_id=r.organization_id
   JOIN agents_platform.agent_versions v ON v.id=r.version_id LEFT JOIN agents_platform.website_appearance_drafts d ON d.agent_id=r.agent_id AND d.organization_id=r.organization_id
   WHERE r.id=$1 AND r.account_id=$2 AND a.deleted_at IS NULL ${lock?"FOR UPDATE OF r":""}`,[z.uuid().parse(id),accountId])).rows[0];
  if(!row) throw new PlatformError("NOT_FOUND",404,"Review unavailable");
  await this.membership(db,{accountId,organizationId:row.organization_id}); return row;
 }
 private dto(row:Review) {return {id:row.id,agentId:row.agent_id,agentName:row.agent_name,allowedOrigins:row.allowed_origins,instructions:row.instructions,appearance:websiteAppearanceSchema.parse(row.appearance??defaultWebsiteAppearance),sources:row.sources??[],state:row.state==="pending"&&row.expired?"expired":row.state,deploymentId:row.deployment_id,reviewUrl:new URL(`/app/mcp/website-review?request=${row.id}`,this.publicUrl).toString()};}
 async propose(scope:Scope & {connectionId:string},raw:unknown) {
  const input=z.strictObject({agentId:z.uuid(),requestId:z.uuid(),allowedOrigins:z.array(z.string().min(1).max(2048)).min(1).max(10)}).parse(raw);
  const origins=[...new Set(input.allowedOrigins.map(normalizeWebsiteDomain))];
  return transaction(this.pool,async db=>{
   await this.membership(db,scope);
   await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
   const existing=(await db.query<Review>(`SELECT r.*,a.name agent_name,r.expires_at<=now() expired FROM agents_platform.mcp_website_reviews r JOIN agents_platform.agents a ON a.id=r.agent_id WHERE r.organization_id=$1 AND r.account_id=$2 AND r.request_id=$3`,[scope.organizationId,scope.accountId,input.requestId])).rows[0];
   if(existing){if(existing.agent_id!==input.agentId||existing.connection_id!==scope.connectionId||JSON.stringify(existing.allowed_origins)!==JSON.stringify(origins))throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request identifier was used for another change");return this.dto(await this.row(db,scope.accountId,existing.id));}
   const agent=(await db.query("SELECT name FROM agents_platform.agents WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE",[input.agentId,scope.organizationId])).rows[0];
   if(!agent)throw new PlatformError("NOT_FOUND",404,"Agent not found");
   const version=(await db.query("SELECT id FROM agents_platform.agent_versions WHERE agent_id=$1 AND organization_id=$2 ORDER BY number DESC LIMIT 1",[input.agentId,scope.organizationId])).rows[0];
   if(!version)throw new PlatformError("CONFIGURATION_UNAVAILABLE",409,"Save the agent settings first");
   const appearance=(await db.query("SELECT revision FROM agents_platform.website_appearance_drafts WHERE organization_id=$1 AND agent_id=$2",[scope.organizationId,input.agentId])).rows[0];
   const id=randomUUID();await db.query("INSERT INTO agents_platform.mcp_website_reviews(id,request_id,organization_id,account_id,connection_id,agent_id,version_id,appearance_revision,allowed_origins) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,input.requestId,scope.organizationId,scope.accountId,scope.connectionId,input.agentId,version.id,Number(appearance?.revision??0),JSON.stringify(origins)]);
   return this.dto(await this.row(db,scope.accountId,id));
  });
 }
 async get(accountId:string,id:string){return this.dto(await this.row(this.pool,accountId,id));}
 async getForScope(scope:Scope,id:string){const row=await this.row(this.pool,scope.accountId,id);if(row.organization_id!==scope.organizationId)throw new PlatformError("NOT_FOUND",404,"Review unavailable");return this.dto(row);}
 async decide(accountId:string,id:string,approved:boolean) {
  return transaction(this.pool,async db=>{
   const row=await this.row(db,accountId,id,true);
   if(row.state!=="pending")return this.dto(row);
   if(row.expired)throw new PlatformError("REVIEW_EXPIRED",409,"Review expired");
   if(!approved){await db.query("UPDATE agents_platform.mcp_website_reviews SET state='cancelled' WHERE id=$1",[row.id]);return this.dto({...row,state:"cancelled"});}
   await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[row.organization_id]);
   if(!(await db.query("SELECT 1 FROM agents_platform.mcp_oauth_connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND revoked_at IS NULL AND 'agents:manage'=ANY(scopes) FOR SHARE",[row.connection_id,row.organization_id,accountId])).rowCount)throw new PlatformError("ACCESS_DENIED",403,"Connection access is unavailable");
   await db.query("SELECT id FROM agents_platform.agents WHERE id=$1 AND organization_id=$2 FOR UPDATE",[row.agent_id,row.organization_id]);
   const version=(await db.query("SELECT id FROM agents_platform.agent_versions WHERE agent_id=$1 AND organization_id=$2 ORDER BY number DESC LIMIT 1",[row.agent_id,row.organization_id])).rows[0];
   const appearance=(await db.query("SELECT revision FROM agents_platform.website_appearance_drafts WHERE organization_id=$1 AND agent_id=$2",[row.organization_id,row.agent_id])).rows[0];
   if(version?.id!==row.version_id||Number(appearance?.revision??0)!==row.appearance_revision)throw new PlatformError("REVIEW_STALE",409,"Agent settings changed; request a new review");
   const deployment=await new DeploymentStore(this.pool).publishWebsiteInTransaction(db,{accountId,organizationId:row.organization_id,agentId:row.agent_id,versionId:row.version_id,allowedOrigins:row.allowed_origins});
   await db.query("UPDATE agents_platform.mcp_website_reviews SET state='approved',deployment_id=$2 WHERE id=$1",[row.id,deployment.id]);
   return this.dto({...row,state:"approved",deployment_id:deployment.id});
  });
 }
}
