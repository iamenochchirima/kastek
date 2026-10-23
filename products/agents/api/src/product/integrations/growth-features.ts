import { z } from "zod";
import type { GrowthAgentFeatureId, GrowthAgentPublication } from "@kasitek-labs/contracts";
import { defaultBusinessConfiguration, PlatformError, type AgentConfiguration } from "../../contracts/contracts";
import { registerProductManifest, createProductBindings } from "../../capabilities/products/product-capabilities";
const feature=z.enum(["assistant","research","content","campaigns"]);
const optional=z.strictObject({knowledge:z.boolean(),skills:z.boolean(),memory:z.boolean(),delegation:z.boolean(),sandbox:z.boolean(),workflows:z.boolean(),connections:z.boolean()});
const publication=z.strictObject({manifest:z.unknown(),presets:z.array(z.strictObject({id:feature,name:z.string().min(1).max(240),description:z.string().max(512),instructions:z.string().min(1).max(32768),operations:z.array(z.string().min(1).max(128)).max(24)})).length(4),policy:z.strictObject({revision:z.string().min(1).max(128),optionalCapabilities:optional})});
export function validateGrowthPublication(input:unknown):GrowthAgentPublication {
  const result=publication.parse(input);
  if(new Set(result.presets.map(p=>p.id)).size!==4||Object.values(result.policy.optionalCapabilities).some(Boolean))throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The requested product authority is not installed");
  const manifest=registerProductManifest(result.manifest as GrowthAgentPublication["manifest"]);
  if(manifest.product!=="growth")throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The manifest belongs to another product");
  for(const preset of result.presets)if(new Set(preset.operations).size!==preset.operations.length||preset.operations.some(op=>!manifest.operations.some(d=>d.operation===op)))throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The preset exceeds the product manifest");
  return {...result,manifest};
}
export function growthFeatureConfiguration(publication:GrowthAgentPublication,id:GrowthAgentFeatureId,organizationId:string,tenantId:string):AgentConfiguration {
  const definition=publication.presets.find(item=>item.id===id);
  if(!definition)throw new PlatformError("PRODUCT_PRESET_UNAVAILABLE",409,"The product preset is unavailable");
  const config=defaultBusinessConfiguration();
  config.program={id:"tool-directed",version:"3"};config.instructions=definition.instructions;config.tools=[];
  config.productBindings=createProductBindings(publication.manifest,organizationId,{originProduct:"growth",originTenantId:tenantId,tenantId,mappingRef:`growth:${tenantId}`,policyRevision:publication.policy.revision},definition.operations);
  return config;
}
export function assertGrowthOptionalAuthority(config:AgentConfiguration,publication:GrowthAgentPublication):void {
  const requested={knowledge:config.sourceRevisionIds.length>0,skills:config.skillIds.length>0,memory:config.memory.enabled,
    delegation:config.capabilities.delegation.enabled,sandbox:config.capabilities.sandbox.enabled,
    workflows:config.capabilities.workflows.enabled,connections:config.connectedToolBindingIds.length>0};
  if(Object.entries(requested).some(([kind,enabled])=>enabled&&!publication.policy.optionalCapabilities[kind as keyof typeof requested])||config.capabilities.businessActions.enabled)
    throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",409,"The selected capability has no product authority");
}
