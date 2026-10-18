import type { Pool } from "pg";
import { deliveryTargetsFromEnvironment } from "../adapters/providers/report-delivery";
import { PlatformError } from "../contracts/contracts";
import { TaskArtifactStore } from "../execution/artifacts/task-artifacts";
import { connectionVaultFromEnvironment } from "../infrastructure/vault";
import { ConnectionStore } from "../product/connections/connections";
import { ActionService } from "../workflows/report-delivery/actions";
export function actionsFromEnvironment(pool:Pool,artifacts:TaskArtifactStore,env:NodeJS.ProcessEnv=process.env):{connections:ConnectionStore;actions:ActionService}|undefined{
 const vault=connectionVaultFromEnvironment(env),targets=deliveryTargetsFromEnvironment(env);if(!vault){if(targets.length)throw new PlatformError("CONNECTION_VAULT_UNAVAILABLE",503,"Connection credentials are unavailable");return;}
 return{connections:new ConnectionStore(pool,vault,targets),actions:new ActionService(pool,{vault,targets,artifacts})};
}
