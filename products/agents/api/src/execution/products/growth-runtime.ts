import type { Pool } from "pg";
import type { GrowthAgentAction, GrowthAgentActionInputs, GrowthAgentActionOperation, GrowthAgentActionOutputs } from "@kasitek-labs/contracts";
import { randomUUID } from "node:crypto";
import { GrowthActionClient } from "../../adapters/products/growth-action-client";
import { requestDigest, PlatformError } from "../../contracts/contracts";
import { registerProductAdapter } from "../../capabilities/products/product-capabilities";
import { validateGrowthPublication } from "../../product/integrations/growth-features";
import { EvidenceStore } from "../context/evidence";
import { ProductRuntime } from "./product-runtime";
const handlers=["workspace.read","content.list","content.read","campaigns.list","campaigns.read","analytics.read","draft.prepare"].map(operation=>`growth.${operation}@1`);
export const growthInstalledAdapterManifest={schemaVersion:1 as const,id:"growth-product",release:"2",executableDigest:requestDigest({release:"growth-product-v2",handlers}),transports:["native_http" as const],protocolVersions:[],boundedSchemaValidation:true as const};
const clients=new WeakMap<GrowthActionClient,{handlers:readonly string[];invoke:GrowthActionClient["invoke"]}>();
export class GrowthProductRuntime extends ProductRuntime {
  constructor(pool:Pool,readonly client:GrowthActionClient,evidence=new EvidenceStore(pool)) {
    super(pool,evidence);
    let adapter=clients.get(client);
    if(!adapter){adapter={handlers,invoke:client.invoke.bind(client)};clients.set(client,adapter);}
    registerProductAdapter(growthInstalledAdapterManifest,adapter);
  }
  async loadPublications():Promise<void> {
    const rows=(await this.pool.query("SELECT publication FROM agents_platform.growth_capability_publications ORDER BY created_at")).rows;
    for(const row of rows)validateGrowthPublication(row.publication);
  }
  async call<K extends GrowthAgentActionOperation>(taskId:string,operationId:string,operation:K,input:GrowthAgentActionInputs[K]):Promise<GrowthAgentActionOutputs[K]> {
    const s=(await this.pool.query("SELECT p.*,t.principal FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id WHERE t.id=$1 AND t.product='growth'",[taskId])).rows[0];
    if(!s||s.principal.kind!=="human")throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
    return this.client.call({version:"1",requestId:randomUUID(),operationId,tenantId:s.tenant_id,actor:{issuer:s.principal.issuer,subject:s.principal.subject},taskId,conversationId:s.conversation_id,
      featureId:s.feature_id,context:s.context,contextRevision:s.context_revision,operation,input} as GrowthAgentAction<K>);
  }
  async readReview(taskId:string,reviewId:string){
    await this.authorizeTask(taskId);
    return this.call(taskId,"review-read:"+randomUUID(),"draft.reconcile",{reviewId});
  }
}
