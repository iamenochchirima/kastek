import { randomUUID } from "node:crypto";
import { PlatformError } from "../../contracts/contracts";
import type { ProductRuntime } from "./product-runtime";
import { ProductActionClient } from "../../adapters/products/product-action-client";
import { loadExecution } from "../lifecycle/state";

export function registerAgencyOriginAuthority(runtime:ProductRuntime,env:NodeJS.ProcessEnv=process.env):boolean {
  if(!env.AGENCY_PRODUCT_API_URL||!env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY)return false;
  const client=new ProductActionClient({origin:env.AGENCY_PRODUCT_API_URL,privateKey:env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY.replace(/\\n/g,"\n"),
    issuer:env.AGENTS_PRODUCT_ACTION_ISSUER??"https://agents.kasitek.co.za",keyId:env.AGENTS_PRODUCT_ACTION_KEY_ID??"agents-v1",environment:env.NODE_ENV});
  runtime.registerOriginAuthorizer("agencies",async(taskId,db)=>{
    const execution=await loadExecution(db,taskId),principal=execution.task.principal;
    const scope=(await db.query(`SELECT p.* FROM agents_platform.product_task_contexts p WHERE p.task_id=$1 AND p.product='agencies'`,[execution.task.root_task_id])).rows[0];
    if(!scope?.client_id||principal.kind!=="human")throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Agency client execution access is unavailable");
    const result=await client.authorizeOrigin({version:"1",product:"agencies",requestId:randomUUID(),taskId,conversationId:scope.conversation_id,
      tenantId:scope.tenant_id,clientId:scope.client_id,actor:{issuer:principal.issuer,subject:principal.subject}});
    if(result.authorized!==true)throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Agency client execution access is unavailable");
  });
  return true;
}
