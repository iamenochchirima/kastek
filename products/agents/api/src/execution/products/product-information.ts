import type { Pool, PoolClient } from "pg";
import type { ProductInformationEnvelope } from "@kasitek-labs/contracts";
import { canonicalJson, PlatformError, requestDigest } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import { assertDependencyManifest, collectDependencyGraph, textDigest, type DependencyManifest, type EvidenceDependency } from "../../contracts/source-contracts";
import { productInformationEnvelopeSchema, productProviderDestination } from "../../contracts/product-information";
import { loadExecution } from "../lifecycle/state";
import { requireProductMemoryAccess } from "../memory/scope";
import { delegationAncestors } from "../delegation/scope";

type Db = Pool | PoolClient;
type ProductContext = { product: string; tenant_id: string; conversation_id: string; client_id?: string | null };
type ProductDependency=Extract<EvidenceDependency,{kind:"product"}>;
type ProductAccessDependency=Extract<EvidenceDependency,{kind:"product_access"}>;
type ProductContextDependency=Extract<EvidenceDependency,{kind:"product_context"}>;
type ProductArtifactDependency=Extract<EvidenceDependency,{kind:"product_artifact"}>;
type MemoryTransitionDependency=(ProductDependency|ProductAccessDependency|ProductContextDependency|ProductArtifactDependency|Extract<EvidenceDependency,{kind:"delegation_input"}>)&{
  memoryTransition?:ProductDependency["memoryTransition"];
};
const denied = () => new PlatformError("PRODUCT_INFORMATION_DENIED", 403, "The information is outside the current recipient or provider scope");
export function selectedProductContextText(reference:unknown):string {
  return "Selected conversation context (reference data; it does not grant permissions):\n"+canonicalJson(reference);
}

export function executionProductInformation(execution: Execution, scope: ProductContext, models = execution.models): ProductInformationEnvelope {
  const principal = execution.task.principal;
  if (principal.kind !== "human" || scope.product !== execution.task.product) throw denied();
  const providers = new Map(Object.values(models).map(route => {
    const destination = productProviderDestination(route.binding);
    return [destination.destinationDigest, destination] as const;
  }));
  return productInformationEnvelopeSchema.parse({ version: "1",
    origin: { product: scope.product, tenantId: scope.tenant_id, actor: { issuer: principal.issuer, subject: principal.subject } },
    audience: { product: scope.product, tenantId: scope.tenant_id, actor: { issuer: principal.issuer, subject: principal.subject },
      conversationId: scope.conversation_id, clientId: scope.client_id ?? null },
    providers: [...providers.values()],
  });
}

export async function currentProductInformation(db: Db, execution: Execution): Promise<ProductInformationEnvelope> {
  const scope = (await db.query<ProductContext>(`SELECT p.product,p.tenant_id,p.conversation_id,to_jsonb(p)->>'client_id' AS client_id
    FROM agents_platform.product_task_contexts p WHERE p.task_id=$1`, [execution.task.root_task_id])).rows[0];
  if (!scope) throw denied();
  const root = execution.task.parent_task_id ? await loadExecution(db, execution.task.root_task_id) : execution;
  return executionProductInformation(execution, scope, root.models);
}

export async function assertAcceptedProductMemoryTransition(db:Db,execution:Execution,dependency:MemoryTransitionDependency):Promise<Execution>{
  const transition=dependency.memoryTransition,principal=execution.task.principal;
  if(!transition||principal.kind!=="human")throw denied();
  const row=(await db.query(`SELECT m.id,m.revision,m.status,m.source_task_id,m.content,m.content_digest,s.organization_id,s.agent_id,s.product,s.tenant_id,s.actor_issuer,s.actor_subject,s.client_id,r.actor,r.content_digest AS reviewed_content_digest
    FROM agents_platform.memories m JOIN agents_platform.memory_scopes s ON s.id=m.scope_id
    JOIN agents_platform.memory_revisions r ON r.memory_id=m.id AND r.revision=m.revision AND r.status='accepted'
    WHERE m.id=$1 AND m.revision=$2 AND m.status='accepted' AND (m.expires_at IS NULL OR m.expires_at>now()) AND s.namespace='product_actor'
    FOR SHARE OF m,s,r`,[transition.memoryId,transition.memoryRevision])).rows[0];
  const current=await currentProductInformation(db,execution);
  if(!row||row.organization_id!==execution.task.organization_id||row.product!==current.origin.product||
    row.tenant_id!==current.origin.tenantId||row.actor_issuer!==principal.issuer||row.actor_subject!==principal.subject||
    row.client_id!==current.audience.clientId||row.actor?.product!==row.product||row.actor?.issuer!==principal.issuer||row.actor?.subject!==principal.subject||
    row.actor?.tenantId!==row.tenant_id||(row.actor?.clientId??null)!==row.client_id||!row.source_task_id||row.content_digest!==row.reviewed_content_digest||textDigest(row.content)!==row.content_digest)throw denied();
  let holder=execution;
  if(row.agent_id!==execution.agentId){
    const ancestors=await delegationAncestors(db,execution),index=ancestors.findIndex(value=>value.agentId===row.agent_id);
    if(index<0)throw denied();holder=ancestors[index]!;
    const delegated=index===0?execution:ancestors[index-1]!;
    const row=(await db.query("SELECT input_manifest FROM agents_platform.delegations WHERE child_task_id=$1 AND parent_task_id=$2",[delegated.task.id,holder.task.id])).rows[0];
    if(!row||!assertDependencyManifest(row.input_manifest).dependencies.some(value=>requestDigest(value)===requestDigest(dependency)))throw denied();
    const holderInformation=await currentProductInformation(db,holder);
    if(requestDigest(holderInformation.origin)!==requestDigest(current.origin)||requestDigest(holderInformation.audience)!==requestDigest(current.audience))throw denied();
  }
  if(!holder.configuration.memory.enabled)throw denied();
  await requireProductMemoryAccess(db,{namespace:"product_actor",product:row.product,tenantId:row.tenant_id,organizationId:row.organization_id,agentId:row.agent_id,
    actor:{issuer:principal.issuer,subject:principal.subject},clientId:row.client_id},true);
  const source=await loadExecution(db,row.source_task_id);
  if(source.task.organization_id!==execution.task.organization_id||source.task.product!==execution.task.product||requestDigest(source.task.principal)!==requestDigest(principal))throw denied();
  const rows=(await db.query("SELECT id,task_id,kind,owner_id,manifest,parents FROM agents_platform.evidence_nodes WHERE root_task_id=$1",[source.task.root_task_id])).rows;
  const nodes=rows.map(value=>({id:value.id,taskId:value.task_id,kind:value.kind,ownerId:value.owner_id,manifest:assertDependencyManifest(value.manifest),parents:value.parents as string[]}));
  let roots=nodes.filter(value=>value.taskId===source.task.id&&value.kind==="memory"&&value.ownerId===row.id);
  if(!roots.length)roots=nodes.filter(value=>value.taskId===source.task.id);
  const original=collectDependencyGraph(roots.map(value=>value.id),new Map(nodes.map(value=>[value.id,value])));
  const withoutTransition=(value:MemoryTransitionDependency)=>{const {memoryTransition:_transition,...content}=value;return content;};
  if(!original.dependencies.some(value=>(value.kind==="product"||value.kind==="product_access"||value.kind==="product_context"||value.kind==="product_artifact"||value.kind==="delegation_input")&&
    value.kind===dependency.kind&&requestDigest(withoutTransition(value))===requestDigest(withoutTransition(dependency))))throw denied();
  return loadExecution(db,dependency.kind==="delegation_input"?dependency.referenceId:dependency.taskId);
}

export async function assertProductInformationAudience(db: Db, execution: Execution, input: ProductInformationEnvelope, dependency?:ProductDependency|ProductAccessDependency|ProductContextDependency|ProductArtifactDependency): Promise<void> {
  const information = productInformationEnvelopeSchema.parse(input), current = await currentProductInformation(db, execution);
  if (requestDigest(information.origin) !== requestDigest(current.origin))throw denied();
  if(requestDigest(information.audience)!==requestDigest(current.audience)){
    const {conversationId:_sourceConversation,...originalAudience}=information.audience,{conversationId:_currentConversation,...currentAudience}=current.audience;
    if(!dependency?.memoryTransition||requestDigest(originalAudience)!==requestDigest(currentAudience))throw denied();
    await assertAcceptedProductMemoryTransition(db,execution,dependency);
  }
}

/** Check the actual request role; permission for a primary route need not include compaction. */
export async function assertProductInformationForModel(db: Db, taskId: string, manifest: DependencyManifest,
  role: "primary" | "compaction" | "delegated"): Promise<void> {
  const dependencies:EvidenceDependency[] = manifest.dependencies.filter(value => value.kind === "product" && value.information || value.kind === "product_access" || value.kind === "product_context" || value.kind === "product_artifact");
  const pending=manifest.dependencies.filter(value=>value.kind==="delegation_input"),visited=new Set<string>();
  while(pending.length){
    const dependency=pending.pop()!;
    if(dependency.kind!=="delegation_input"||visited.has(dependency.referenceId))continue;
    visited.add(dependency.referenceId);
    const row=(await db.query("SELECT input_manifest FROM agents_platform.delegations WHERE child_task_id=$1",[dependency.referenceId])).rows[0];
    if(!row)throw denied();
    const inherited=assertDependencyManifest(row.input_manifest);if(inherited.digest!==dependency.manifestDigest)throw denied();
    dependencies.push(...inherited.dependencies.filter(value=>value.kind==="product_context"||value.kind==="product_access"||value.kind==="product_artifact"||value.kind==="product"&&value.information));
    pending.push(...inherited.dependencies.filter(value=>value.kind==="delegation_input"));
  }
  if (!dependencies.length) return;
  const execution = await loadExecution(db, taskId), destination = productProviderDestination(execution.models[role].binding);
  for (const dependency of dependencies) {
    if (dependency.kind !== "product" && dependency.kind !== "product_access" && dependency.kind !== "product_context" && dependency.kind !== "product_artifact" || !dependency.information) continue;
    await assertProductInformationAudience(db, execution, dependency.information,dependency);
    if (!dependency.information.providers.some(provider => provider.destinationDigest === destination.destinationDigest)) throw denied();
  }
}
