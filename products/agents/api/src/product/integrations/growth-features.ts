import { orchestrationPolicySchema, orchestrationTools } from "../../contracts/orchestration";
import { z } from "zod";
import type {ModelDescriptor} from "../../contracts/model-providers";
import type { GrowthAgentDelegationPolicy, GrowthAgentFeatureId, GrowthAgentPublication } from "@kasitek-labs/contracts";
import { defaultBusinessConfiguration, PlatformError, type AgentConfiguration } from "../../contracts/contracts";
import { registerProductManifest, createProductBindings } from "../../capabilities/products/product-capabilities";
const feature=z.enum(["assistant","research","content","campaigns"]);
const optional=z.strictObject({knowledge:z.boolean(),skills:z.boolean(),memory:z.boolean(),delegation:z.boolean(),sandbox:z.boolean(),workflows:z.boolean(),connections:z.boolean()});
const delegationPolicy=z.strictObject({maxChildren:z.number().int().min(1).max(8),maxDepth:z.number().int().positive().max(2147483647).nullable(),
  policy:orchestrationPolicySchema,childLimits:z.strictObject({maxTokens:z.number().int().min(2048).max(64000).nullable(),maxActiveMs:z.number().int().min(1000).max(300000).nullable()}),
  delegates:z.strictObject({assistant:z.array(feature).max(3),research:z.array(feature).max(3),content:z.array(feature).max(3),campaigns:z.array(feature).max(3)})});
const publication=z.strictObject({manifest:z.unknown(),presets:z.array(z.strictObject({id:feature,name:z.string().min(1).max(240),description:z.string().max(512),instructions:z.string().min(1).max(32768),operations:z.array(z.string().min(1).max(128)).max(64)})).length(4),policy:z.strictObject({revision:z.string().min(1).max(128),optionalCapabilities:optional,delegation:delegationPolicy.optional()})});

// Publications 3–10 predate an explicit policy object. Keep their exact managed behavior
// while requiring current publications to describe the delegation graph as data.
const legacyDelegates:GrowthAgentDelegationPolicy["delegates"]={assistant:["research","content","campaigns"],research:[],content:[],campaigns:[]};
const legacyDelegationPolicy=(maxDepth:number|null,maxTasks:number|null,maxTokens:number|null,maxActiveMs:number|null):GrowthAgentDelegationPolicy=>({
  maxChildren:2,maxDepth,policy:{maxTasks,maxStalls:3},childLimits:{maxTokens,maxActiveMs},delegates:legacyDelegates,
});
const legacyGrowthDelegationPolicies:Record<string,GrowthAgentDelegationPolicy>={
  "3":legacyDelegationPolicy(1,16,48000,300000),
  "4":legacyDelegationPolicy(1,null,null,null),
  "5":legacyDelegationPolicy(1,null,null,null),
  "6":legacyDelegationPolicy(1,null,null,null),
  "7":legacyDelegationPolicy(1,null,null,null),
  "8":legacyDelegationPolicy(1,null,null,null),
  "9":legacyDelegationPolicy(null,null,null,null),
  "10":legacyDelegationPolicy(1,16,48000,300000),
};

export function growthDelegationPolicy(publication:GrowthAgentPublication):GrowthAgentDelegationPolicy|null {
  if(!publication.policy.optionalCapabilities.delegation)return null;
  return publication.policy.delegation??legacyGrowthDelegationPolicies[publication.policy.revision]??null;
}

export function growthFeatureProvisionOrder(publication:GrowthAgentPublication):GrowthAgentPublication["presets"] {
  const presets=[...publication.presets].sort((a,b)=>Number(a.id==="assistant")-Number(b.id==="assistant"));
  const policy=growthDelegationPolicy(publication),byId=new Map(presets.map(preset=>[preset.id,preset]));
  if(!policy)return presets;
  const result:typeof presets=[],visiting=new Set<GrowthAgentFeatureId>(),visited=new Set<GrowthAgentFeatureId>();
  const visit=(id:GrowthAgentFeatureId)=>{
    if(visited.has(id))return;
    if(visiting.has(id))throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"Growth delegation cannot contain a cycle");
    visiting.add(id);
    for(const child of policy.delegates[id])visit(child);
    visiting.delete(id);visited.add(id);
    const preset=byId.get(id);if(preset)result.push(preset);
  };
  for(const preset of presets)visit(preset.id);
  return result;
}

export function validateGrowthPublication(input:unknown):GrowthAgentPublication {
  const result=publication.parse(input);
  if(new Set(result.presets.map(p=>p.id)).size!==4||Object.entries(result.policy.optionalCapabilities).some(([kind,enabled])=>enabled&&!["delegation","memory","knowledge","skills"].includes(kind)))throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The requested product authority is not installed");
  if(result.policy.optionalCapabilities.delegation&&!growthDelegationPolicy(result as GrowthAgentPublication))throw new PlatformError("PRODUCT_DEFAULTS_INCOMPLETE",409,"Growth delegation policy is incomplete");
  if(!result.policy.optionalCapabilities.delegation&&result.policy.delegation)throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"Growth delegation policy has no product authority");
  if(result.policy.delegation){
    const delegation=result.policy.delegation;
    for(const parent of Object.keys(delegation.delegates) as GrowthAgentFeatureId[]){
      const children=delegation.delegates[parent];
      if(new Set(children).size!==children.length||children.includes(parent)||children.some(id=>!result.presets.some(preset=>preset.id===id)))throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"Growth delegation roster is invalid");
    }
    const state=new Map<GrowthAgentFeatureId,"visiting"|"visited">();
    const visit=(id:GrowthAgentFeatureId)=>{
      if(state.get(id)==="visiting")throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"Growth delegation cannot contain a cycle");
      if(state.get(id)==="visited")return;
      state.set(id,"visiting");for(const child of delegation.delegates[id])visit(child);state.set(id,"visited");
    };
    for(const preset of result.presets)visit(preset.id);
    if(delegation.delegates.assistant.length!==3)throw new PlatformError("PRODUCT_DEFAULTS_INCOMPLETE",409,"Growth assistant specialist defaults are incomplete");
  }
  const manifest=registerProductManifest(result.manifest as GrowthAgentPublication["manifest"]);
  if(manifest.product!=="growth")throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The manifest belongs to another product");
  for(const preset of result.presets)if(new Set(preset.operations).size!==preset.operations.length||preset.operations.some(op=>!manifest.operations.some(d=>d.operation===op)))throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The preset exceeds the product manifest");
  return {...result,manifest};
}
export function growthFeatureConfiguration(publication:GrowthAgentPublication,id:GrowthAgentFeatureId,organizationId:string,tenantId:string,model?:ModelDescriptor,specialists?:import("../../contracts/contracts").AgentConfiguration["capabilities"]["delegation"]):AgentConfiguration {
  const definition=publication.presets.find(item=>item.id===id);
  if(!definition)throw new PlatformError("PRODUCT_PRESET_UNAVAILABLE",409,"The product preset is unavailable");
  const config=defaultBusinessConfiguration();
  if(model?.maxOutputTokens.value!==null&&model?.maxOutputTokens.value!==undefined)config.model.maxOutputTokens=Math.min(config.model.maxOutputTokens,model.maxOutputTokens.value);
  config.context={mode:"automatic"};
  config.program={id:"tool-directed",version:"3"};config.instructions=definition.instructions;config.tools=["artifact.create"];
  if(id==="assistant"&&publication.policy.optionalCapabilities.delegation&&(!specialists?.enabled||specialists.bindings.length!==3))
    throw new PlatformError("PRODUCT_DEFAULTS_INCOMPLETE",409,"Growth specialist defaults are incomplete");
  if(specialists?.enabled){
    if(!publication.policy.optionalCapabilities.delegation)throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"Growth delegation is unavailable");
    config.program={id:"tool-directed",version:"4"};config.tools=["artifact.create",...orchestrationTools];config.capabilities.delegation=specialists;
  }
  config.productBindings=createProductBindings(publication.manifest,organizationId,{originProduct:"growth",originTenantId:tenantId,tenantId,mappingRef:`growth:${tenantId}`,policyRevision:publication.policy.revision},definition.operations);
  return config;
}
export function assertGrowthOptionalAuthority(config:AgentConfiguration,publication:GrowthAgentPublication):void {
  const requested={knowledge:config.sourceRevisionIds.length>0,skills:config.skillIds.length>0,memory:config.memory.enabled,
    delegation:config.capabilities.delegation.enabled,sandbox:config.capabilities.sandbox.enabled,
    workflows:config.capabilities.workflows.enabled,connections:config.connectedToolBindingIds.length>0};
  if(Object.entries(requested).some(([kind,enabled])=>enabled&&!publication.policy.optionalCapabilities[kind as keyof typeof requested])||config.capabilities.businessActions.enabled||config.capabilities.enquiries?.enabled)
    throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The selected capability has no product authority");
}

/** Existing customized connected selections can be retained without granting new tools. */
export function assertGrowthConfigurationPreservingConnections(config:AgentConfiguration, previous:AgentConfiguration, publication:GrowthAgentPublication):void {
  if(publication.policy.optionalCapabilities.connections)return assertGrowthOptionalAuthority(config,publication);
  const direct=new Set(previous.connectedToolBindingIds);
  if(config.connectedToolBindingIds.some(id=>!direct.has(id)))throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The selected connection is unavailable");
  if(config.capabilities.delegation.enabled){
    const roles=previous.capabilities.delegation.enabled?previous.capabilities.delegation.bindings:[];
    for(const role of config.capabilities.delegation.bindings){
      const prior=roles.find(item=>item.id===role.id),allowed=new Set(prior?.connectedToolBindingIds??[]);
      if(role.connectedToolBindingIds.some(id=>!allowed.has(id)))throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The selected connection is unavailable");
    }
  }
  assertGrowthOptionalAuthority({...config,connectedToolBindingIds:[]},publication);
}
