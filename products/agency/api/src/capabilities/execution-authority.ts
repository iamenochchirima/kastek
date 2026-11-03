import type { TenantContext } from "../context.js";
import { AGENT_ROLES } from "../controllers/read-helpers.js";
import { forbidden } from "../error.js";

export function agencyActorIssuer(context:TenantContext):string {
  return context.config.env.AGENCY_IDENTITY_ISSUER??"https://agency.kasitek.co.za/identity";
}

/** The shared service never substitutes its own membership for this product decision. */
export async function authorizeAgencyExecution(context:TenantContext,input:{tenantId:string;clientId:string;actor:{issuer:string;subject:string};purpose?:"execute"|"configure_model";requireClientSetup?:boolean}):Promise<{clientName:string}> {
  if(input.actor.issuer!==agencyActorIssuer(context))throw forbidden();
  const row=(await context.pool.query(`SELECT c.name AS client_name FROM tenant_users u JOIN workspaces w ON w.id=u.workspace_id AND w.status='active'
    JOIN tenant_clients c ON c.workspace_id=u.workspace_id AND c.id=$3 AND c.status='active'
    WHERE u.id=$2 AND u.workspace_id=$1 AND u.status='active'
      AND EXISTS(SELECT 1 FROM tenant_user_roles r WHERE r.tenant_user_id=u.id AND r.role=ANY($4::text[]))
      AND (EXISTS(SELECT 1 FROM tenant_user_roles r WHERE r.tenant_user_id=u.id AND r.role IN ('owner','admin'))
        OR EXISTS(SELECT 1 FROM tenant_client_assignments a WHERE a.workspace_id=u.workspace_id AND a.tenant_client_id=c.id AND a.tenant_user_id=u.id AND a.status='active'))
      AND ($5::boolean IS FALSE OR EXISTS(SELECT 1 FROM shared_agent_client_setups s
        WHERE s.workspace_id=u.workspace_id AND s.tenant_client_id=c.id AND s.tenant_user_id=u.id AND s.enabled))`,
    [input.tenantId,input.actor.subject,input.clientId,input.purpose==="configure_model"?["owner","admin"]:AGENT_ROLES,input.requireClientSetup===true])).rows[0];
  if(!row)throw forbidden();
  return {clientName:row.client_name};
}
