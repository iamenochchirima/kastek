import { randomUUID } from "node:crypto";
import type { ProductGrantBinding } from "@kasitek-labs/contracts";
import type { TenantContext } from "../context.js";
import { transaction } from "../db.js";
import { forbidden, TenantError } from "../error.js";
import { agencyCapabilityManifest, capabilityDigest } from "./manifest.js";
import { agencyActorIssuer, authorizeAgencyExecution } from "./execution-authority.js";
import { agencyExecutionClient } from "./execution-client.js";

export async function ensureAgencyClientExecution(context:TenantContext,workspaceId:string,clientId:string,userId:string):Promise<void>{
  const actor={issuer:agencyActorIssuer(context),subject:userId};await authorizeAgencyExecution(context,{tenantId:workspaceId,clientId,actor});
  const mappingRef="agency-client-"+capabilityDigest({workspaceId,clientId,userId});
  const old=(await context.pool.query("SELECT enabled FROM shared_agent_client_setups WHERE workspace_id=$1 AND tenant_client_id=$2 AND tenant_user_id=$3",[workspaceId,clientId,userId])).rows[0];
  if(old?.enabled===false)throw forbidden();
  const result=await agencyExecutionClient(context).execute({version:"1",requestId:randomUUID(),tenantId:workspaceId,clientId,actor,operation:"tenant.ensure",input:{mappingRef,manifest:agencyCapabilityManifest}}) as {binding?:ProductGrantBinding};
  const binding=result.binding,a=binding?.authority;
  if(!binding||typeof binding.id!=="string"||!/^[a-f0-9]{64}$/.test(binding.digest)||!a||a.kind!=="product"||a.originProduct!=="agencies"||a.destinationProduct!=="agencies"||a.originTenantId!==workspaceId||a.tenantId!==workspaceId||a.clientId!==clientId||a.originClientId!==clientId||a.mappingRef!==mappingRef||a.manifestDigest!==agencyCapabilityManifest.digest||binding.definition?.providerOperation!=="agency.workspace_agents.read")throw new TenantError(502,"Invalid client agent setup");
  await transaction(context.pool,async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[mappingRef]);
    const prior=(await db.query("SELECT * FROM product_capability_mappings WHERE id=$1 FOR UPDATE",[mappingRef])).rows[0];
    if(prior&&(prior.revoked_at||prior.workspace_id!==workspaceId||prior.tenant_client_id!==clientId||prior.origin_client_id!==clientId||prior.tenant_user_id!==userId||prior.actor_issuer!==actor.issuer||prior.actor_subject!==actor.subject))throw forbidden();
    if(!prior)await db.query(`INSERT INTO product_capability_mappings(id,origin_product,origin_tenant_id,actor_issuer,actor_subject,workspace_id,tenant_user_id,tenant_client_id,origin_client_id,expires_at)
      VALUES($1,'agencies',$2,$3,$4,$2,$4,$5,$5,now()+interval '1 day')`,[mappingRef,workspaceId,actor.issuer,userId,clientId]);
    else await db.query("UPDATE product_capability_mappings SET expires_at=now()+interval '1 day' WHERE id=$1 AND revoked_at IS NULL",[mappingRef]);
    const revoked=(await db.query("SELECT 1 FROM product_capability_grants WHERE mapping_id=$1 AND operation=$2 AND binding_id=$3 AND revoked_at IS NOT NULL",[mappingRef,binding.definition.providerOperation,binding.id])).rowCount;
    if(revoked)throw forbidden();
    const agents=(await db.query("SELECT id FROM workspace_agents WHERE workspace_id=$1 AND tenant_client_id=$2 ORDER BY id",[workspaceId,clientId])).rows.map(row=>row.id);
    const grant=await db.query(`INSERT INTO product_capability_grants(mapping_id,operation,manifest_digest,descriptor_digest,handler_ref,policy_revision,binding_id,binding_digest,agent_ids,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '1 day')
      ON CONFLICT(mapping_id,operation,binding_id) DO UPDATE SET agent_ids=excluded.agent_ids,expires_at=excluded.expires_at
      WHERE product_capability_grants.binding_digest=excluded.binding_digest AND product_capability_grants.revoked_at IS NULL RETURNING binding_id`,
      [mappingRef,binding.definition.providerOperation,a.manifestDigest,a.descriptorDigest,a.handlerRef,a.policyRevision,binding.id,binding.digest,JSON.stringify(agents)]);
    if(grant.rowCount!==1)throw forbidden();
    const priorSetup=(await db.query("SELECT enabled,binding FROM shared_agent_client_setups WHERE workspace_id=$1 AND tenant_client_id=$2 AND tenant_user_id=$3 FOR UPDATE",[workspaceId,clientId,userId])).rows[0];
    if(priorSetup&&(priorSetup.enabled===false||capabilityDigest(priorSetup.binding)!==capabilityDigest(binding)))throw forbidden();
    await db.query(`INSERT INTO shared_agent_client_setups(workspace_id,tenant_client_id,tenant_user_id,mapping_id,binding)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace_id,tenant_client_id,tenant_user_id) DO NOTHING`,[workspaceId,clientId,userId,mappingRef,binding]);
  });
}
