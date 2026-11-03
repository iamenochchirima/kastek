import type { PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";
import type { ResolvedModelBinding } from "../../contracts/model-providers";

/** Check saved credential custody only; this does not contact the model provider. */
export async function assertModelCredentialAvailable(db:PoolClient,binding:ResolvedModelBinding):Promise<void> {
  const credential=(await db.query("SELECT state,endpoint,protocol FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2 AND revision=$3 FOR SHARE",
    [binding.organizationId,binding.connectionId,binding.credentialRevision])).rows[0];
  if(credential?.state==="revoked")throw new PlatformError("MODEL_CREDENTIAL_REVOKED",409,"Model credentials revoked");
  if(!credential||credential.state!=="active"||credential.endpoint!==binding.endpoint||credential.protocol!==binding.protocol)
    throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE",409,"Model credentials unavailable");
}
