import type { PoolClient } from "pg";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { connectedToolAuthorityIds, PlatformError, type AgentConfiguration } from "../../contracts/contracts";

/** Retain only bindings already pinned to the preceding immutable version. */
export async function growthConnectedPins(db:PoolClient,organizationId:string,previousVersionId:string,configuration:AgentConfiguration) {
  const ids=connectedToolAuthorityIds(configuration);
  if(!ids.length)return {ids,direct:[]};
  const rows=(await db.query(`SELECT b.binding FROM agents_platform.version_connected_tools v
    JOIN agents_platform.capability_bindings b ON b.organization_id=v.organization_id AND b.id=v.binding_id
    WHERE v.organization_id=$1 AND v.version_id=$2 AND b.id=ANY($3::uuid[]) ORDER BY b.alias`,[organizationId,previousVersionId,ids])).rows;
  const bindings=rows.map(row=>capabilityBindingSchema.parse(row.binding));
  if(bindings.length!==ids.length || new Set(bindings.map(binding=>binding.id)).size!==ids.length || bindings.some(binding=>!ids.includes(binding.id)))
    throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"Previously selected connected tools are unavailable");
  return {ids,direct:bindings.filter(binding=>configuration.connectedToolBindingIds.includes(binding.id))};
}
export async function pinGrowthConnectedTools(db:PoolClient,organizationId:string,versionId:string,ids:string[]) {
  if(ids.length)await db.query("INSERT INTO agents_platform.version_connected_tools(organization_id,version_id,binding_id) SELECT $1,$2,unnest($3::uuid[])",[organizationId,versionId,ids]);
}
