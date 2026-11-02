import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";

const identifiers=z.array(z.string().min(1).max(80).regex(/^[a-z][a-z0-9_.-]*$/)).max(16).refine(values=>new Set(values).size===values.length);
const schema=z.strictObject({connectionProfiles:identifiers.default([]),permissions:identifiers.default([]),runtimes:identifiers.default([])});
export interface SkillRequirements {readonly connectionProfiles:readonly string[];readonly permissions:readonly string[];readonly runtimes:readonly string[]}
export function parseSkillRequirements(value:string|undefined):SkillRequirements {
  let input:unknown={};
  if(value!==undefined){if(Buffer.byteLength(value)>4096)throw new PlatformError("SKILL_PACKAGE_INVALID",400,"Skill requirements exceed metadata limits");try{input=JSON.parse(value);}catch{throw new PlatformError("SKILL_PACKAGE_INVALID",400,"kasitek.requirements metadata must contain a JSON object");}}
  const result=schema.safeParse(input);
  if(!result.success)throw new PlatformError("SKILL_PACKAGE_INVALID",400,"Skill requirements must list bounded connection profiles, permissions and runtimes");
  return Object.freeze({connectionProfiles:Object.freeze(result.data.connectionProfiles),permissions:Object.freeze(result.data.permissions),runtimes:Object.freeze(result.data.runtimes)});
}
