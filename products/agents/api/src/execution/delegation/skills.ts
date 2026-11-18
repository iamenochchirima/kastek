import { skillPackageCodec } from "../../capabilities/skills/package";
import type { Pool,PoolClient } from "pg";
import type { AgentConfiguration } from "../../contracts/contracts";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { assertCurrentSkillPolicy } from "../../capabilities/skills/current-policy";
import { configurationSkillAuthority } from "../../capabilities/skills/requirement-authority";
import { loadSkillRevisions } from "../memory/skills";

/** A pinned specialist authorizes its own reviewed skills, constrained by its delegated tools/resources. */
export async function delegatedSkills(db:Pool|PoolClient,input:{organizationId:string;agentId:string;configuration:AgentConfiguration;connectedBindings:CapabilityBinding[]}){
  await assertCurrentSkillPolicy(db,{task:{organization_id:input.organizationId},agentId:input.agentId,
    configuration:input.configuration,connectedBindings:input.connectedBindings},configurationSkillAuthority(input.configuration));
  return loadSkillRevisions(db,input.organizationId,input.agentId,input.configuration.skillIds,skillPackageCodec);
}
