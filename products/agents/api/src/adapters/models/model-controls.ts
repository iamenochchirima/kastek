import { z } from "zod";
import profiles from "./model-control-profiles.json";
import { requestDigest } from "../../contracts/contracts";
import { modelGenerationSchema, type ModelGenerationSettings } from "../../contracts/model-generation";
import type { EffectiveExecutionPolicy, ModelDescriptor } from "../../contracts/model-providers";
import { ProviderTransportError } from "../../contracts/model-transport";
const profileSchema = z.strictObject({ provider:z.string(),endpoint:z.url(),protocol:z.string(),model:z.string(),
  native:z.enum(["router_effort","openai_effort","anthropic_adaptive","anthropic_budget","google_budget","google_level"]).optional(),
  kind:z.enum(["effort","budget","level"]).optional(),values:z.array(z.string()).optional(),minTokens:z.number().int().nonnegative().optional(),maxTokens:z.number().int().positive().optional(),
  temperature:z.strictObject({min:z.number(),max:z.number()}).optional(),source:z.url() });
const reviewed = z.array(profileSchema).parse(profiles);
export const modelControlsRevision = requestDigest(reviewed);
function profile(model:ModelDescriptor,endpoint:string) {
  return reviewed.find(item=>item.provider===model.providerId&&item.protocol===model.protocol&&item.endpoint===endpoint.replace(/\/$/,"")&&new RegExp(item.model).test(model.id.replace(/^models\//,"")));
}
export function modelControls(model:ModelDescriptor,policy:Pick<EffectiveExecutionPolicy,"maxOutputTokens">,endpoint:string) {
  const rule=profile(model,endpoint), reasoning = rule?.kind && model.capabilities.reasoning.value===true ? {
    kind:rule.kind, ...(rule.values?{values:rule.values}:{}), ...(rule.kind==="budget"?{minTokens:rule.minTokens??0,maxTokens:Math.min(rule.maxTokens??2147483647,policy.maxOutputTokens-1)}:{}), source:rule.source,
  }:null;
  return {temperature:rule?.temperature?{...rule.temperature,source:rule.source}:null,reasoning};
}
export function validateGeneration(model:ModelDescriptor,policy:Pick<EffectiveExecutionPolicy,"maxOutputTokens">,endpoint:string,raw:unknown):ModelGenerationSettings {
  const parsed=modelGenerationSchema.safeParse(raw??{});
  if(!parsed.success)throw new ProviderTransportError("MODEL_GENERATION_INVALID","rejected",422);
  const settings=parsed.data, controls=modelControls(model,policy,endpoint),reasoning=settings.reasoning;
  if(settings.temperature!==undefined&&(!controls.temperature||settings.temperature<controls.temperature.min||settings.temperature>controls.temperature.max))throw new ProviderTransportError("MODEL_TEMPERATURE_UNSUPPORTED","rejected",422);
  if(reasoning){const allowed=controls.reasoning;
    if(!allowed||allowed.kind!==reasoning.kind||(reasoning.kind==="budget"?(reasoning.tokens<(allowed.minTokens??0)||reasoning.tokens>(allowed.maxTokens??-1)):!allowed.values?.includes(reasoning.value)))throw new ProviderTransportError("MODEL_REASONING_CONFIGURATION_INVALID","rejected",422);
  }
  return settings;
}
export function generationSdkOptions(model:ModelDescriptor,endpoint:string,settings:ModelGenerationSettings):Record<string,unknown>|undefined {
  const rule=profile(model,endpoint),reasoning=settings.reasoning;
  if(rule?.native==="anthropic_adaptive"&&reasoning?.kind==="effort")return{thinkingEnabled:true,effort:reasoning.value};
  if(rule?.native==="anthropic_budget"&&reasoning?.kind==="budget")return{thinkingEnabled:true,thinkingBudgetTokens:reasoning.tokens};
  return undefined;
}
/** Apply only trusted reviewed settings after native SDK preparation and before counting/byte checks. */
export function applyGeneration(model:ModelDescriptor,policy:Pick<EffectiveExecutionPolicy,"maxOutputTokens">,endpoint:string,raw:unknown,payload:Record<string,unknown>):void {
  const settings=validateGeneration(model,policy,endpoint,raw),rule=profile(model,endpoint),reasoning=settings.reasoning;
  if(settings.temperature!==undefined){
    if(model.protocol==="google_generate_content") (payload.generationConfig as Record<string,unknown>).temperature=settings.temperature;
    else payload.temperature=settings.temperature;
  }
  if(model.providerId==="openai"&&model.protocol==="openai_responses"&&model.capabilities.reasoning.value===true){
    // Preserve native provider defaults; the SDK's synthetic 'off' must not disable an unspecified mode.
    delete payload.reasoning;
    payload.include=[...new Set([...(Array.isArray(payload.include)?payload.include:[]),"reasoning.encrypted_content"])];
  }
  if(!reasoning)return;
  if(rule?.native==="router_effort"&&reasoning.kind==="effort")payload.reasoning={effort:reasoning.value};
  else if(rule?.native==="openai_effort"&&reasoning.kind==="effort")payload.reasoning={effort:reasoning.value};
  else if(rule?.native==="anthropic_adaptive"&&reasoning.kind==="effort"){payload.thinking={type:"adaptive"};payload.output_config={effort:reasoning.value};}
  else if(rule?.native==="anthropic_budget"&&reasoning.kind==="budget")payload.thinking={type:"enabled",budget_tokens:reasoning.tokens};
  else if(rule?.native==="google_budget"&&reasoning.kind==="budget")(payload.generationConfig as Record<string,unknown>).thinkingConfig={thinkingBudget:reasoning.tokens,includeThoughts:false};
  else if(rule?.native==="google_level"&&reasoning.kind==="level")(payload.generationConfig as Record<string,unknown>).thinkingConfig={thinkingLevel:reasoning.value.toUpperCase(),includeThoughts:false};
}
