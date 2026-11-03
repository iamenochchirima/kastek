import { productAuthorityBindings, sameProductAuthority } from "../../capabilities/products/product-capabilities";
import type { Pool, PoolClient } from "pg";
import { PlatformError, type AdmissionAuthority } from "../../contracts/contracts";

export async function assertProductAuthority(db: Pool | PoolClient, authority: AdmissionAuthority, versionId: string, grantId?: string): Promise<void> {
  if(authority.product === "agents") throw new PlatformError("PRODUCT_SCOPE_DENIED",403,"A delegated product identity is required");
  const allowed = await db.query(`SELECT 1 FROM agents_platform.product_execution_authorities a
    JOIN agents_platform.product_execution_tenants p ON p.product=a.product AND p.organization_id=a.organization_id AND p.client_id=a.client_id AND p.issuer=a.issuer
    JOIN agents_platform.execution_grants g ON g.id=a.grant_id
    WHERE a.product=$1 AND a.organization_id=$2 AND a.client_id=$3 AND p.revoked_at IS NULL
      AND g.resource_id=$4 AND g.principal=$5::jsonb AND g.version_id=$6 AND g.revoked_at IS NULL AND ($7::uuid IS NULL OR g.expires_at>now())
      AND ($7::uuid IS NULL OR g.id=$7) FOR SHARE OF a,p,g`,
  [authority.product,authority.organizationId,authority.callerClientId,authority.resourceId,JSON.stringify(authority.principal),versionId,grantId??null]);
  if(!allowed.rowCount && !await assertDerivedProductAuthority(db,authority,versionId,grantId)) throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Delegated product authority is unavailable");
}

/** Each product child derives from its immediate parent, then rechecks the complete ancestor chain. */
async function assertDerivedProductAuthority(db:Pool|PoolClient,authority:AdmissionAuthority,versionId:string,grantId?:string):Promise<boolean>{
  const row=(await db.query(`SELECT r.*,coalesce(r.effective_configuration,v.configuration) AS root_configuration,c.effective_configuration,d.binding_id,
      n.enabled AS specialist_enabled,rg.revoked_at AS root_revoked
    FROM agents_platform.tasks c JOIN agents_platform.tasks r ON r.id=c.parent_task_id
    JOIN agents_platform.execution_grants g ON g.id=c.grant_id JOIN agents_platform.execution_grants rg ON rg.id=r.grant_id
    JOIN agents_platform.agent_versions v ON v.id=r.version_id
    JOIN agents_platform.delegations d ON d.child_task_id=c.id AND d.parent_task_id=r.id
    JOIN agents_platform.agent_versions cv ON cv.id=c.version_id
    JOIN agents_platform.product_execution_features n ON n.product=c.product AND n.organization_id=c.organization_id AND n.agent_id=cv.agent_id
    WHERE c.product=$6 AND r.product=c.product AND c.organization_id=$1 AND r.organization_id=c.organization_id
      AND c.resource_id=$2 AND c.principal=$3::jsonb AND r.principal=c.principal AND c.version_id=$4
      AND c.caller_client_id=$7 AND r.caller_client_id=c.caller_client_id AND c.depth=r.depth+1 AND c.root_task_id=r.root_task_id
      AND g.product=c.product AND g.organization_id=c.organization_id AND g.resource_id=c.resource_id AND g.principal=c.principal AND g.version_id=c.version_id AND g.caller_client_id=c.caller_client_id
      AND g.revoked_at IS NULL AND rg.revoked_at IS NULL AND rg.operations ? 'delegation.execute'
      AND ($5::uuid IS NULL OR g.id=$5 AND g.expires_at>now())`,
  [authority.organizationId,authority.resourceId,JSON.stringify(authority.principal),versionId,grantId??null,authority.product,authority.callerClientId])).rows[0];
  if(!row||!row.specialist_enabled)return false;
  const {agentConfigurationSchema}=await import("../../contracts/contracts");
  const parent=agentConfigurationSchema.parse(row.root_configuration),child=agentConfigurationSchema.parse(row.effective_configuration);
  const role=parent.capabilities.delegation.enabled?parent.capabilities.delegation.bindings.find(binding=>binding.id===row.binding_id&&binding.versionId===versionId):undefined;
  if(parent.program.version!=="4"||!role)return false;
  const pool=role.productBindingIds===undefined?parent.productBindings:productAuthorityBindings(parent).filter(binding=>role.productBindingIds!.includes(binding.id));
  if(productAuthorityBindings(child).some(binding=>!pool.some(value=>sameProductAuthority(value,binding))))return false;
  await assertProductAuthority(db,{product:row.product,organizationId:row.organization_id,resourceId:row.resource_id,callerClientId:row.caller_client_id,principal:row.principal},row.version_id,grantId?row.grant_id:undefined);
  return true;
}
