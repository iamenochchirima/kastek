import type { Pool,PoolClient } from "pg";
import type { Execution } from "../../contracts/execution";
import { PlatformError } from "../../contracts/contracts";
import {parseSkillPackage} from "./package";
import { assertSkillRequirements } from "./requirement-authority";

/** Called within the current-authority transaction, including before final publication. */
export async function assertCurrentSkillPolicy(db:Pool|PoolClient,execution:Execution,permissions:readonly string[]):Promise<void> {
  const ids=execution.configuration.skillIds;if(!ids.length)return;
  const rows=(await db.query(`SELECT s.id,s.content_digest,p.files,r.content_digest AS reviewed_digest
    FROM agents_platform.skill_revisions s LEFT JOIN agents_platform.skill_packages p ON p.skill_revision_id=s.id
    LEFT JOIN agents_platform.skill_package_reviews r ON r.skill_revision_id=s.id
    WHERE s.organization_id=$1 AND s.agent_id=$2 AND s.id=ANY($3::uuid[])`,[execution.task.organization_id,execution.agentId,ids])).rows;
  if(rows.length!==new Set(ids).size)throw new PlatformError("SKILL_SCOPE_DENIED",403,"Selected skill is unavailable");
  const states=(await db.query(`SELECT skill_revision_id,state FROM agents_platform.skill_installation_states
    WHERE organization_id=$1 AND agent_id=$2 AND skill_revision_id=ANY($3::uuid[]) ORDER BY skill_revision_id FOR SHARE`,[execution.task.organization_id,execution.agentId,ids])).rows;
  const packages=new Map(rows.filter(row=>row.files).map(row=>[row.id,parseSkillPackage({files:row.files.map((file:any)=>({path:file.path,content:file.content,encoding:file.encoding}))})]));
  const needsProfiles=[...packages.values()].some(pkg=>pkg.requirements.connectionProfiles.length);
  const profiles:string[]=[];
  if(needsProfiles){
    const pins=execution.connectedBindings.flatMap(binding=>binding.connection?[binding.connection]:[]);
    const current=(await db.query(`SELECT id,profile_id,policy_revision FROM agents_platform.connections WHERE organization_id=$1
      AND id=ANY($2::uuid[]) AND state='active' AND expires_at>now() ORDER BY id FOR SHARE`,[execution.task.organization_id,pins.map(pin=>pin.id)])).rows;
    for(const pin of pins)if(current.some(row=>row.id===pin.id&&row.policy_revision===pin.policyRevision&&row.profile_id===pin.profileId))profiles.push(pin.profileId);
  }
  for(const row of rows){
    const state=states.find(state=>state.skill_revision_id===row.id);
    if(state&&state.state!=="enabled"||row.files&&!state)throw new PlatformError("SKILL_DISABLED",409,"Selected skill installation is unavailable");
    if(row.files){
      if(row.reviewed_digest!==row.content_digest)throw new PlatformError("SKILL_REVIEW_REQUIRED",409,"Selected skill requires an exact package review");
      const pkg=packages.get(row.id)!;
      if(pkg.contentDigest!==row.content_digest)throw new PlatformError("SKILL_PACKAGE_CORRUPT",409,"Skill package content has changed");
      assertSkillRequirements(pkg.requirements,execution.configuration,profiles,permissions);
    }
  }
}
