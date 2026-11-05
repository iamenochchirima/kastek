import type { PoolClient } from "pg";
import type { GrowthAgentCapabilityUpgradeApply, GrowthAgentCapabilityUpgradeChange, GrowthAgentCapabilityUpgradePreview, GrowthAgentFeatureId, GrowthAgentPublication } from "@kasitek-labs/contracts";
import { agentConfigurationSchema, PlatformError, requestDigest, sourceAuthorityIds, type AgentConfiguration } from "../../contracts/contracts";
import { createModelAlias, type CapabilityBinding } from "../../contracts/capability-catalog";
import { capabilityBindingPresentation } from "../../capabilities/tool-presentation";
import { readableToolTitle } from "../../capabilities/tool-discovery";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { toolDescriptorPresentation } from "../../capabilities/tool-descriptors";
import { productAuthorityBindings, productDescriptor } from "../../capabilities/products/product-capabilities";
import { pinProductCompositionSources, validateProductNativeSelection } from "../../capabilities/products/native-selection";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { growthFeatureConfiguration, growthDelegationPolicy, assertGrowthConfigurationPreservingConnections, validateGrowthPublication } from "./growth-features";
import { growthConnectedPins,pinGrowthConnectedTools } from "./growth-connected-pins";

type Baseline = Pick<AgentConfiguration,"tools"|"productBindings"|"commissionableProductBindings"|"program"> & { delegation: AgentConfiguration["capabilities"]["delegation"] };
type Delegation = AgentConfiguration["capabilities"]["delegation"];
type Specialist = Extract<Delegation,{enabled:true}>["bindings"][number];
const roster=(value:Delegation):Specialist[]=>value.enabled?value.bindings:[];
type Feature = {feature_id:GrowthAgentFeatureId;organization_id:string;agent_id:string;version_id:string;revision:number;enabled:boolean;name:string;configuration:AgentConfiguration;draft:unknown;managed_configuration_digest:string|null;managed_capability_baseline:Baseline|null;tool_bindings:unknown;effective_composition:unknown;deleted_at:unknown};
interface Update {feature:Feature;configuration:AgentConfiguration;baseline:Baseline;versionId:string;changes:GrowthAgentCapabilityUpgradeChange[]}
export interface GrowthCapabilityUpgradePlan {preview:GrowthAgentCapabilityUpgradePreview;updates:Update[];publication:GrowthAgentPublication}
const changed=()=>new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Review the update again.");
function uuid(value:unknown):string {const digest=requestDigest(value);return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;}
export function growthCapabilityBaseline(config:AgentConfiguration):Baseline {return structuredClone({tools:config.tools,productBindings:config.productBindings,...(config.commissionableProductBindings?{commissionableProductBindings:config.commissionableProductBindings}:{}),program:config.program,delegation:config.capabilities.delegation});}
function normalized(binding:CapabilityBinding|undefined):unknown {if(!binding)return null;const {manifestDigest:_manifest,policyRevision:_policy,...scope}=binding.authority!;void _manifest;void _policy;return {definition:binding.definition,adapter:binding.adapter,policy:binding.policy,limits:binding.limits,scope:{organizationId:binding.organizationId,...scope}};}
function equal(left:unknown,right:unknown):boolean {return requestDigest(left??null)===requestDigest(right??null);}
function stableBindings(config:AgentConfiguration,seed:unknown):void {
  config.productBindings=config.productBindings.map(binding=>{
    const {digest:_old,...content}=binding;void _old;const id=uuid([seed,binding.definition.providerOperation]);
    const value={...content,id,alias:createModelAlias(id)};return {...value,digest:requestDigest(value)};
  });
}
function authorityKey(binding:CapabilityBinding):string {const {id:_id,alias:_alias,digest:_digest,...scope}=binding;void _id;void _alias;void _digest;return requestDigest(scope);}
function sameAuthority(left:CapabilityBinding,right:CapabilityBinding):boolean {return left.definition.providerOperation===right.definition.providerOperation&&authorityKey(left)===authorityKey(right);}
/** Reuse only byte-equivalent destination authority; distinct restrictions remain distinct grants. */
export function coalesceGrowthAuthority(config:AgentConfiguration):number {
  const direct=[...config.productBindings],pool:CapabilityBinding[]=[],aliases=new Map<string,string>(),canonical=new Map<string,CapabilityBinding>();
  for(const binding of direct){productDescriptor(binding);canonical.set(authorityKey(binding),binding);}
  for(const binding of config.commissionableProductBindings??[]){
    productDescriptor(binding);const key=authorityKey(binding),identical=canonical.get(key);
    if(identical)aliases.set(binding.id,identical.id);else {pool.push(binding);canonical.set(key,binding);}
  }
  if(pool.length)config.commissionableProductBindings=pool;else delete config.commissionableProductBindings;
  if(config.capabilities.delegation.enabled)config.capabilities.delegation.bindings=config.capabilities.delegation.bindings.map(binding=>binding.productBindingIds===undefined?binding:{...binding,productBindingIds:[...new Set(binding.productBindingIds.map(id=>aliases.get(id)??id))]});
  return aliases.size;
}
/** Canonical commissions are product-owned only for fresh or fully managed defaults. */
export function growthDefaultCommissions(config:AgentConfiguration,children:ReadonlyMap<string,AgentConfiguration>):AgentConfiguration {
  if(!config.capabilities.delegation.enabled)return config;
  const pool=[...config.commissionableProductBindings??[]];
  for(const role of config.capabilities.delegation.bindings){const child=children.get(role.versionId);if(child)pool.push(...productAuthorityBindings(child));}
  config.commissionableProductBindings=pool;coalesceGrowthAuthority(config);
  const authority=productAuthorityBindings(config);
  config.capabilities.delegation.bindings=config.capabilities.delegation.bindings.map(role=>{const child=children.get(role.versionId);if(!child)return role;const selected=productAuthorityBindings(child);return {...role,productBindingIds:authority.filter(ceiling=>selected.some(product=>sameAuthority(ceiling,product))).map(binding=>binding.id)};});
  return config;
}
function bindingSummary(value:CapabilityBinding|undefined):string {return value?`${readableToolTitle(value.policy.effect)} · ${readableToolTitle(value.policy.approval)} review · revision ${value.definition.product?.revision??"unknown"}`:"Not assigned";}

/** Plans contain only exact current configuration and installed publication authority. Preview grants nothing. */
export async function planGrowthCapabilityUpgrade(db:PoolClient,input:{tenantId:string;featureId:GrowthAgentFeatureId;publication:GrowthAgentPublication;actor:{issuer:string;subject:string};issuer:string},resolutions:GrowthAgentCapabilityUpgradeApply["resolutions"]={}):Promise<GrowthCapabilityUpgradePlan>{
  const publication=validateGrowthPublication(input.publication),publicationDigest=requestDigest(publication);
  const features=(await db.query(`SELECT f.*,a.name,a.draft,a.deleted_at,v.configuration,v.tool_bindings,v.effective_composition
    FROM agents_platform.product_execution_features f JOIN agents_platform.agents a ON a.id=f.agent_id AND a.organization_id=f.organization_id
    JOIN agents_platform.agent_versions v ON v.id=f.version_id AND v.organization_id=f.organization_id
    WHERE f.product='growth' AND f.tenant_id=$1 ORDER BY f.feature_id FOR UPDATE OF f,a`,[input.tenantId])).rows as Feature[];
  if(features.length!==4)throw new PlatformError("PRODUCT_DEFAULTS_INCOMPLETE",409,"Growth agent defaults are incomplete");
  const selected=features.find(feature=>feature.feature_id===input.featureId);if(!selected||selected.deleted_at)throw new PlatformError("NOT_FOUND",404,"Agent not found");
  for(const feature of features)feature.configuration=agentConfigurationSchema.parse(feature.configuration);
  const expectedRevisions=Object.fromEntries(features.map(feature=>[feature.feature_id,feature.revision]));
  const preview:GrowthAgentCapabilityUpgradePreview={featureId:input.featureId,targetPublicationRevision:publication.manifest.revision,targetPublicationDigest:publicationDigest,diffDigest:"",expectedRevisions,features:[],conflicts:[],unavailable:[],canApply:false};
  const updates:Update[]=[],alternatives:unknown[]=[];let selectedChanged=false;const pendingCapacity=new Set<string>();
  const versionSeed=[input.tenantId,input.featureId,publicationDigest,features.map(f=>[f.feature_id,f.version_id,requestDigest(f.configuration)])];
  async function baseline(feature:Feature):Promise<Baseline|undefined>{
    if(feature.managed_capability_baseline)return feature.managed_capability_baseline;
    const versions=(await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number",[feature.organization_id,feature.agent_id])).rows;
    const old=versions.find(version=>requestDigest(version.configuration)===feature.managed_configuration_digest);
    return old?growthCapabilityBaseline(agentConfigurationSchema.parse(old.configuration)):undefined;
  }
  function choose<T>(feature:Feature,id:string,label:string,kind:GrowthAgentCapabilityUpgradeChange["kind"],before:T|undefined,base:T|undefined,target:T|undefined,changes:GrowthAgentCapabilityUpgradeChange[],compare:(value:T|undefined)=>unknown=value=>value):T|undefined {
    if(equal(compare(before),compare(target)))return target;
    const conflict=!equal(compare(before),compare(base))&&!(base===undefined&&target===undefined);
    if(before===undefined&&base===undefined&&target===undefined)return undefined;
    const row={id:`${feature.feature_id}:${id}`,kind,label,action:before===undefined?"add" as const:target===undefined?"remove" as const:"change" as const,conflict};
    changes.push(row);alternatives.push({id:row.id,before,base,target});
    if(conflict){preview.conflicts.push({id:row.id,featureId:feature.feature_id,label});return resolutions[row.id]==="use_update"?target:before;}
    return target;
  }
  const base=await baseline(selected),config=structuredClone(selected.configuration),changes:GrowthAgentCapabilityUpgradeChange[]=[];
  if(!base){preview.unavailable.push({code:"CAPABILITY_BASELINE_UNAVAILABLE",message:"The prior managed capability baseline is unavailable."});}
  if(!equal(selected.draft,selected.configuration))preview.unavailable.push({code:"CONFIGURATION_CHANGED",message:"Save or discard unpublished agent changes first."});
  if(base){
    const policy=growthDelegationPolicy(publication),children=policy?.delegates[selected.feature_id]??[];
    const delegation=children.length?{enabled:true,maxChildren:policy!.maxChildren,maxDepth:policy!.maxDepth,policy:policy!.policy,bindings:children.map(id=>{
      const child=features.find(feature=>feature.feature_id===id)!;
      return {id,label:child.name,description:publication.presets.find(preset=>preset.id===id)?.description??child.name,versionId:child.version_id,sourceRevisionIds:sourceAuthorityIds(child.configuration),connectedToolBindingIds:[],tools:child.configuration.tools.filter(tool=>["knowledge.search","knowledge.read","memory.search","memory.read","memory.propose","artifact.create","sandbox.analyze"].includes(tool)),maxTokens:policy!.childLimits.maxTokens,maxActiveMs:policy!.childLimits.maxActiveMs};
    })}:undefined;
    const target=growthFeatureConfiguration(publication,selected.feature_id,selected.organization_id,input.tenantId,undefined,delegation);
    stableBindings(target,[input.tenantId,selected.feature_id,publicationDigest]);
    const operation=(binding:CapabilityBinding)=>binding.definition.providerOperation;
    const old=new Map(base.productBindings.map(binding=>[operation(binding),binding])),current=new Map(config.productBindings.map(binding=>[operation(binding),binding])),desired=new Map(target.productBindings.map(binding=>[operation(binding),binding]));
    config.productBindings=[];
    for(const name of [...new Set([...old.keys(),...current.keys(),...desired.keys()])].sort()){
      const before=current.get(name),wanted=desired.get(name),prior=old.get(name);
      // A custom addition outside the target remains an explicit existing grant, never a new grant.
      const value=!prior&&!wanted?before:choose(selected,`operation:${name}`,capabilityBindingPresentation(wanted??before??prior!).title??readableToolTitle(name),"operation",before,prior,wanted,changes,normalized);
      const row=changes.at(-1);if(row?.id===`${selected.feature_id}:operation:${name}`){row.before=bindingSummary(before);row.after=bindingSummary(wanted);}
      if(value)config.productBindings.push(value);
    }
    const tools=new Set(config.tools),baseTools=new Set(base.tools),targetTools=new Set(target.tools);
    for(const name of [...new Set([...baseTools,...targetTools])].sort()){
      if(name.startsWith("memory.")||name.startsWith("knowledge."))continue;
      const value=choose(selected,`tool:${name}`,toolDescriptorPresentation(name)?.title??readableToolTitle(name),"runtime",tools.has(name)?true:undefined,baseTools.has(name)?true:undefined,targetTools.has(name)?true:undefined,changes);
      if(value)tools.add(name);else tools.delete(name);
    }
    config.tools=[...tools];
    const oldDelegation=base.delegation,currentDelegation=config.capabilities.delegation,targetDelegation=target.capabilities.delegation;
    const settings=(value:Delegation)=>value.enabled?{enabled:true as const,maxChildren:value.maxChildren,maxDepth:value.maxDepth,...(value.policy?{policy:value.policy}:{})}:{enabled:false as const};
    const picked=choose(selected,"delegation-policy","Specialist policy","specialist",settings(currentDelegation),settings(oldDelegation),settings(targetDelegation),changes)!;
    const oldRoster=new Map(roster(oldDelegation).map(binding=>[binding.id,binding])),currentRoster=new Map(roster(currentDelegation).map(binding=>[binding.id,binding])),targetRoster=new Map(roster(targetDelegation).map(binding=>[binding.id,binding]));
    const bindings:Specialist[]=[];
    for(const id of [...new Set([...oldRoster.keys(),...currentRoster.keys(),...targetRoster.keys()])].sort()){
      const compare=(binding:Specialist|undefined)=>{if(!binding)return undefined;const {versionId:_version,...value}=binding;void _version;return value;};
      let binding=choose(selected,`specialist:${id}`,targetRoster.get(id)?.label??currentRoster.get(id)?.label??id,"specialist",currentRoster.get(id),oldRoster.get(id),targetRoster.get(id),changes,compare);
      const currentBinding=currentRoster.get(id),oldBinding=oldRoster.get(id);
      if(binding&&currentBinding&&resolutions[`${selected.feature_id}:specialist:${id}`]==="use_update"){
        binding=structuredClone(binding);
        for(const key of ["tools","sourceRevisionIds","connectedToolBindingIds","maxTokens","maxActiveMs","label","description"] as const)if(!oldBinding||!equal(currentBinding[key],oldBinding[key]))Object.assign(binding,{[key]:structuredClone(currentBinding[key])});
      }
      if(binding)bindings.push(binding);
    }
    const deniedTools=new Set(base.tools.filter(tool=>!tools.has(tool)));
    config.capabilities.delegation=picked.enabled&&bindings.length?{...picked,bindings:bindings.map(binding=>({...binding,tools:binding.tools.filter(tool=>!deniedTools.has(tool))}))}:{enabled:false};
    if(config.capabilities.delegation.enabled)config.program={id:"tool-directed",version:"4"};
    const direct=new Set(config.productBindings.map(binding=>binding.definition.providerOperation));
    const oldPool=new Map((base.commissionableProductBindings??[]).map(binding=>[operation(binding),binding]));
    const currentPool=new Map((config.commissionableProductBindings??[]).map(binding=>[operation(binding),binding]));
    const targetPool=new Map<string,CapabilityBinding>();
    const explicitlyDenied=new Set([...old.keys()].filter(name=>!current.has(name)&&resolutions[`${selected.feature_id}:operation:${name}`]!=="use_update"));
    for(const binding of roster(config.capabilities.delegation)){
      const child=features.find(feature=>feature.version_id===binding.versionId);
      const named=binding.productBindingIds===undefined?null:new Set([...selected.configuration.productBindings,...selected.configuration.commissionableProductBindings??[]].filter(ceiling=>binding.productBindingIds!.includes(ceiling.id)).map(operation));
      if(child)for(const product of productAuthorityBindings(child.configuration))if((!named||named.has(operation(product)))&&!direct.has(operation(product))&&!explicitlyDenied.has(operation(product)))targetPool.set(operation(product),product);
    }
    const commissioned:CapabilityBinding[]=[];
    for(const name of [...new Set([...oldPool.keys(),...currentPool.keys(),...targetPool.keys()])].sort()){
      const before=currentPool.get(name),prior=oldPool.get(name),wanted=targetPool.get(name);
      const chosen=!prior&&!wanted?before:choose(selected,`commission:${name}`,`Specialists: ${capabilityBindingPresentation(wanted??before??prior!).title??readableToolTitle(name)}`,"operation",before,prior,wanted,changes,normalized);
      const row=changes.at(-1);if(row?.id===`${selected.feature_id}:commission:${name}`){row.before=bindingSummary(before);row.after=bindingSummary(wanted);}
      if(chosen)commissioned.push(chosen);
    }
    const retainedIds=new Set(roster(config.capabilities.delegation).filter(binding=>{const currentRole=currentRoster.get(binding.id);return currentRole&&resolutions[`${selected.feature_id}:specialist:${binding.id}`]!=="use_update"&&!equal(currentRole,oldRoster.get(binding.id));}).flatMap(binding=>binding.productBindingIds??[]));
    for(const binding of [...selected.configuration.productBindings,...selected.configuration.commissionableProductBindings??[]])if(retainedIds.has(binding.id)&&!config.productBindings.some(direct=>direct.id===binding.id)&&!commissioned.some(current=>current.id===binding.id)){
      const explicit=resolutions[`${selected.feature_id}:commission:${operation(binding)}`]==="use_update";
      if(explicit&&![...config.productBindings,...commissioned].some(candidate=>sameAuthority(candidate,binding)))throw new PlatformError("CAPABILITY_CONFLICT_UNRESOLVED",409,"Update the specialist link before removing its required capability.");
      commissioned.push(binding);
    }
    if(commissioned.length)config.commissionableProductBindings=commissioned;else delete config.commissionableProductBindings;
    if(targetPool.size)target.commissionableProductBindings=[...targetPool.values()];
    const authorizeRoster=(value:AgentConfiguration,onlyManaged:boolean)=>{
      if(!value.capabilities.delegation.enabled)return;
      const authority=[...value.productBindings,...value.commissionableProductBindings??[]];
      value.capabilities.delegation.bindings=value.capabilities.delegation.bindings.map(binding=>{
        const currentBinding=currentRoster.get(binding.id),oldBinding=oldRoster.get(binding.id);
        const managed=!currentBinding||resolutions[`${selected.feature_id}:specialist:${binding.id}`]==="use_update"||equal(currentBinding,oldBinding);
        if(onlyManaged&&!managed)return binding;
        const child=features.find(feature=>feature.version_id===binding.versionId);if(!child)return binding;
        const childAuthority=productAuthorityBindings(child.configuration);
        return {...binding,productBindingIds:authority.filter(ceiling=>childAuthority.some(product=>sameAuthority(ceiling,product))).map(ceiling=>ceiling.id)};
      });
    };
    authorizeRoster(config,true);authorizeRoster(target,false);
    coalesceGrowthAuthority(config);coalesceGrowthAuthority(target);
    if(new Set([...config.productBindings,...config.commissionableProductBindings??[]].map(binding=>binding.id)).size>64){
      if(preview.conflicts.some(conflict=>conflict.featureId===selected.feature_id&&resolutions[conflict.id]===undefined))pendingCapacity.add(selected.feature_id);
      else throw new PlatformError("CAPABILITY_AUTHORITY_LIMIT",409,`Update ${selected.name} specialist selections before applying its capabilities.`);
    }
    assertGrowthConfigurationPreservingConnections(config,selected.configuration,publication);
    const parsed=agentConfigurationSchema.parse(config),connected=await growthConnectedPins(db,selected.organization_id,selected.version_id,parsed),newBindings=publishedToolBindings(parsed),composition=pendingCapacity.has(selected.feature_id)?null:compilePublishedComposition(parsed,connected.direct);
    if(!equal(newBindings,selected.tool_bindings)||!equal(composition,selected.effective_composition))changes.push({id:`${selected.feature_id}:runtime`,kind:"runtime",action:"change",label:"Current capability protocol",conflict:false});
    selectedChanged=!equal(parsed,selected.configuration)||!equal(newBindings,selected.tool_bindings)||!equal(composition,selected.effective_composition);
    if(selectedChanged||preview.conflicts.some(conflict=>conflict.featureId===selected.feature_id))updates.push({feature:selected,configuration:parsed,baseline:growthCapabilityBaseline(target),versionId:uuid([versionSeed,selected.feature_id]),changes});
  }
  // Any customized coordinator that points at the changed feature receives an explicit pin diff.
  if(updates.length){
    const updated=updates[0]!;
    const versions=(await db.query("SELECT id,agent_id FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2",[selected.organization_id,selected.agent_id])).rows;
    const selectedVersions=new Set(versions.map(version=>version.id));
    for(const parent of features.filter(feature=>!feature.deleted_at&&feature.feature_id!==selected.feature_id&&feature.configuration.capabilities.delegation.enabled)){
      const links=roster(parent.configuration.capabilities.delegation).filter(binding=>selectedVersions.has(binding.versionId));if(!links.length)continue;
      if(!equal(parent.draft,parent.configuration)){preview.unavailable.push({code:"CONFIGURATION_CHANGED",message:`Save or discard unpublished ${parent.name} changes first.`});continue;}
      const parentConfig=structuredClone(parent.configuration),parentChanges:GrowthAgentCapabilityUpgradeChange[]=[],parentBase=await baseline(parent),managedPins=new Set<string>();
      for(const link of links){
        const previousChild=features.find(feature=>feature.agent_id===selected.agent_id)!;
        const oldAuthority=productAuthorityBindings(previousChild.configuration),nextAuthority=pendingCapacity.has(updated.feature.feature_id)?[...new Map([...updated.configuration.productBindings,...updated.configuration.commissionableProductBindings??[]].map(binding=>[binding.id,binding])).values()]:productAuthorityBindings(updated.configuration);
        const parentCeiling=link.productBindingIds===undefined?parent.configuration.productBindings:productAuthorityBindings(parent.configuration).filter(binding=>link.productBindingIds!.includes(binding.id));
        const permittedNames=new Set(parentCeiling.filter(ceiling=>oldAuthority.some(product=>sameAuthority(ceiling,product))).map(binding=>binding.definition.providerOperation));
        const permitted=nextAuthority.filter(binding=>permittedNames.has(binding.definition.providerOperation));
        const target={...link,versionId:updated.versionId,sourceRevisionIds:link.sourceRevisionIds.filter(id=>sourceAuthorityIds(updated.configuration).includes(id)),tools:link.tools.filter(tool=>updated.configuration.tools.includes(tool)),
          productBindingIds:permitted.map(binding=>binding.id)};
        const id=`${parent.feature_id}:pin:${link.id}`;
        parentChanges.push({id,kind:"specialist",action:"change",label:`${link.label} version`,before:link.versionId,after:updated.versionId,conflict:true});
        preview.conflicts.push({id,featureId:parent.feature_id,label:`Update ${parent.name}'s ${link.label} specialist`});alternatives.push({id,before:link,target,commissioned:permitted});
        const currentNames=new Set(productAuthorityBindings(parent.configuration).map(binding=>binding.definition.providerOperation));
        for(const binding of permitted.filter(binding=>!currentNames.has(binding.definition.providerOperation)))parentChanges.push({id:`${id}:${binding.definition.providerOperation}`,kind:"operation",action:"add",label:`${link.label}: ${capabilityBindingPresentation(binding).title??readableToolTitle(binding.definition.providerOperation)}`,before:"Not commissioned",after:bindingSummary(binding),conflict:false});
        if(resolutions[id]==="use_update"&&selectedChanged){
          const baselineRole=parentBase?roster(parentBase.delegation).find(binding=>binding.id===link.id):undefined;
          const policy=(binding:Specialist|undefined)=>{if(!binding)return null;const {versionId:_version,...value}=binding;void _version;return value;};
          if(baselineRole&&equal(policy(link),policy(baselineRole)))managedPins.add(link.id);
          if(!parentConfig.capabilities.delegation.enabled)throw changed();
          parentConfig.capabilities.delegation.bindings=parentConfig.capabilities.delegation.bindings.map(binding=>binding.id===link.id?target:binding);
          const requiredIds=new Set(parentConfig.capabilities.delegation.bindings.flatMap(binding=>binding.productBindingIds??[]));
          const pool=new Map((parentConfig.commissionableProductBindings??[]).map(binding=>[binding.id,binding]));
          for(const binding of permitted){
            const direct=parentConfig.productBindings.findIndex(current=>sameAuthority(current,binding));
            if(direct>=0){const old=parentConfig.productBindings[direct]!;if(requiredIds.has(old.id))pool.set(old.id,old);parentConfig.productBindings[direct]=binding;}
            else {
              for(const [id,current] of pool)if(!requiredIds.has(id)&&sameAuthority(current,binding))pool.delete(id);
              pool.set(binding.id,binding);
            }
          }
          const directIds=new Set(parentConfig.productBindings.map(binding=>binding.id));
          parentConfig.commissionableProductBindings=[...pool.values()].filter(binding=>!directIds.has(binding.id));
        }
      }
      if(coalesceGrowthAuthority(parentConfig))parentChanges.push({id:`${parent.feature_id}:equivalent-authority`,kind:"runtime",action:"change",label:"Reuse equivalent specialist capabilities",conflict:false});
      const capacity=new Set([...parentConfig.productBindings,...parentConfig.commissionableProductBindings??[]].map(binding=>binding.id)).size;
      if(capacity>64)throw new PlatformError("CAPABILITY_AUTHORITY_LIMIT",409,`Keep current for this specialist link, or update ${parent.name} capabilities first.`);
      const parentConnected=await growthConnectedPins(db,parent.organization_id,parent.version_id,parentConfig);
      compilePublishedComposition(parentConfig,parentConnected.direct);
      const nextBaseline=structuredClone(parentBase??growthCapabilityBaseline(parent.configuration));
      if(nextBaseline.delegation.enabled&&parentConfig.capabilities.delegation.enabled&&managedPins.size){
        nextBaseline.delegation.bindings=nextBaseline.delegation.bindings.map(binding=>managedPins.has(binding.id)?structuredClone(roster(parentConfig.capabilities.delegation).find(role=>role.id===binding.id)!):binding);
        const ids=new Set(roster(nextBaseline.delegation).flatMap(binding=>binding.productBindingIds??[]));
        const authority=productAuthorityBindings(parentConfig).filter(binding=>ids.has(binding.id)&&!nextBaseline.productBindings.some(direct=>direct.id===binding.id));
        nextBaseline.commissionableProductBindings=[...new Map([...(nextBaseline.commissionableProductBindings??[]),...authority].map(binding=>[binding.id,binding])).values()];
      }
      updates.push({feature:parent,configuration:parentConfig,baseline:nextBaseline,versionId:uuid([versionSeed,parent.feature_id]),changes:parentChanges});
    }
  }
  for(const update of updates){
    const feature=update.feature;
    try{if(feature.enabled&&!pendingCapacity.has(feature.feature_id))await validateProductNativeSelection(db,{kind:"product_feature",product:"growth",tenantId:input.tenantId,organizationId:feature.organization_id,agentId:feature.agent_id,actor:input.actor,service:{issuer:input.issuer,clientId:"growth-api"},authority:"manage"},update.configuration);}catch(error){if(!(error instanceof PlatformError))throw error;preview.unavailable.push({code:error.code,message:`${feature.name} resources are unavailable.`});}
    preview.features.push({featureId:feature.feature_id,name:feature.name,revision:feature.revision,enabled:feature.enabled,changes:update.changes,preserved:["Instructions","Model","Context","Memory","Sources and skills","Enabled state","Custom specialist tools, sources and limits"]});
  }
  preview.diffDigest=requestDigest({featureId:input.featureId,publicationDigest,features:features.map(feature=>[feature.feature_id,feature.version_id,requestDigest(feature.configuration),requestDigest(feature.draft),feature.enabled]),alternatives,proposed:updates.map(update=>[update.feature.feature_id,update.baseline]),unavailable:preview.unavailable});
  preview.canApply=preview.unavailable.length===0&&updates.some(update=>update.changes.length>0);
  return {preview,updates,publication};
}

export async function applyGrowthCapabilityUpgrade(db:PoolClient,plan:GrowthCapabilityUpgradePlan,input:GrowthAgentCapabilityUpgradeApply,provenance:{product:string;clientId:string;issuer:string},tenantId:string){
  const {preview}=plan;
  if(input.targetPublicationDigest!==preview.targetPublicationDigest||input.diffDigest!==preview.diffDigest||!equal(input.expectedRevisions,preview.expectedRevisions))throw changed();
  const ids=new Set(preview.conflicts.map(conflict=>conflict.id));
  if(Object.keys(input.resolutions).some(id=>!ids.has(id))||[...ids].some(id=>!["keep_current","use_update"].includes(input.resolutions[id]!)))throw new PlatformError("CAPABILITY_CONFLICT_UNRESOLVED",409,"Choose how to resolve each capability conflict.");
  if(!preview.canApply)throw new PlatformError("CAPABILITY_UPGRADE_UNAVAILABLE",409,"This capability update is unavailable.");
  const revisions:Partial<Record<GrowthAgentFeatureId,number>>={};
  for(const update of plan.updates){
    const {feature,configuration}=update;
    const connected=await growthConnectedPins(db,feature.organization_id,feature.version_id,configuration);
    if(equal(configuration,feature.configuration)&&equal(publishedToolBindings(configuration),feature.tool_bindings)&&equal(compilePublishedComposition(configuration,connected.direct),feature.effective_composition))continue;
    const number=feature.revision+1;
    const saved=await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1 AND draft=$4::jsonb",[feature.agent_id,configuration,number,feature.configuration]);if(!saved.rowCount)throw changed();
    await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
      VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`,[update.versionId,feature.organization_id,feature.agent_id,number,configuration,provenance,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,connected.direct)]);
    const mapped=await db.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,managed_defaults_revision=$5,managed_capability_baseline=$6,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2 AND revision=$7",[tenantId,feature.feature_id,update.versionId,number,plan.publication.manifest.revision,update.baseline,feature.revision]);
    if(!mapped.rowCount)throw changed();
    await pinProductCompositionSources(db,{product:"growth",tenantId,organizationId:feature.organization_id},update.versionId,configuration);
    await pinGrowthConnectedTools(db,feature.organization_id,update.versionId,connected.ids);
    revisions[feature.feature_id]=number;
  }
  const existing=(await db.query("SELECT digest FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 AND revision=$2",[tenantId,plan.publication.manifest.revision])).rows[0];
  if(existing&&existing.digest!==preview.targetPublicationDigest)throw new PlatformError("PRODUCT_MANIFEST_CONFLICT",409,"The published revision changed.");
  await db.query("INSERT INTO agents_platform.growth_capability_publications(tenant_id,revision,digest,publication,issuer) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[tenantId,plan.publication.manifest.revision,preview.targetPublicationDigest,plan.publication,provenance.issuer]);
  return {revisions};
}
