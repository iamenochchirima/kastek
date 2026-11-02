import type { Pool,PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";
import { curatedSkillCatalog } from "./curated";
import { parseSkillPackage } from "./package";

/** Only server-owned curated instruction packages are approved for anonymous customer deployment. */
export async function assertPublicSkillPolicy(db:Pool|PoolClient,organizationId:string,agentId:string,ids:string[]) {
  if(!ids.length)return;
  const installed=(await db.query(`SELECT p.source_kind,p.source_slug,p.files,s.content_digest,r.content_digest AS reviewed_digest,st.state
    FROM agents_platform.skill_packages p JOIN agents_platform.skill_revisions s ON s.id=p.skill_revision_id
    JOIN agents_platform.skill_package_reviews r ON r.skill_revision_id=s.id
    JOIN agents_platform.skill_installation_states st ON st.skill_revision_id=s.id
    WHERE s.organization_id=$1 AND s.agent_id=$2 AND s.id=ANY($3::uuid[]) FOR SHARE OF p,s,r,st`,[organizationId,agentId,ids])).rows;
  const curated=curatedSkillCatalog();
  if(installed.length!==ids.length||installed.some(row=>row.state!=="enabled"||row.source_kind!=="curated"||row.reviewed_digest!==row.content_digest||
    parseSkillPackage({files:row.files.map((file:{path:string;content:string;encoding:string})=>({path:file.path,content:file.content,encoding:file.encoding}))}).contentDigest!==row.content_digest||!curated.some(skill=>skill.slug===row.source_slug&&skill.contentDigest===row.content_digest)))
    throw new PlatformError("PUBLIC_SKILL_POLICY_REQUIRED",409,"Customer agents require approved curated instruction skills");
}
