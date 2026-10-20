import { PlatformError,type AgentConfiguration } from "../../contracts/contracts";
import { publishedToolBindings } from "../tool-definitions";
import { toolDescriptor } from "../tool-descriptors";
import type { SkillRequirements } from "./requirements";

export function configurationSkillAuthority(configuration:AgentConfiguration):string[] {
  const operations=new Set<string>(["model.reply"]);
  for(const binding of publishedToolBindings(configuration))for(const authority of toolDescriptor(binding.name)?.requiredAuthority??[])operations.add(authority);
  if(configuration.memory.enabled){operations.add("memory.read");operations.add("memory.propose");}
  if(configuration.connectedToolBindingIds.length||configuration.capabilities.delegation.enabled&&configuration.capabilities.delegation.bindings.some(binding=>binding.connectedToolBindingIds.length)){operations.add("connected.read");operations.add("connected.execute");}
  return [...operations];
}
export function missingSkillRequirements(requirements:SkillRequirements,configuration:AgentConfiguration,profiles:readonly string[],permissions:readonly string[]=configurationSkillAuthority(configuration)) {
  const runtimes=[configuration.executionKind,...(configuration.capabilities.sandbox.enabled?[configuration.capabilities.sandbox.profileId]:[])];
  return {connectionProfiles:requirements.connectionProfiles.filter(value=>!profiles.includes(value)),permissions:requirements.permissions.filter(value=>!permissions.includes(value)),runtimes:requirements.runtimes.filter(value=>!runtimes.includes(value as typeof runtimes[number]))};
}
export function assertSkillRequirements(requirements:SkillRequirements,configuration:AgentConfiguration,profiles:readonly string[],permissions?:readonly string[]) {
  const missing=missingSkillRequirements(requirements,configuration,profiles,permissions);
  if(Object.values(missing).some(values=>values.length))throw new PlatformError("SKILL_REQUIREMENTS_UNAVAILABLE",409,"Select the connections, permissions and runtime required by this skill before using it");
}
