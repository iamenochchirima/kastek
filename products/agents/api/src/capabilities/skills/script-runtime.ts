import type {PoolClient} from "pg";
import {PlatformError} from "../../contracts/contracts";
import {loadExecution,assertCurrentAuthority} from "../../execution/lifecycle/execution";
import {loadSkillRevisions} from "../../execution/memory/memory";
import {readSkillPackageFile,type SkillFileEvidence} from "./package";

export interface SkillScriptReference {skillId:string;revision:number;path:string;packageDigest:string;contentDigest:string}
export interface SkillScriptPackage {reference:SkillScriptReference;files:{path:string;content:Uint8Array}[]}
export interface SkillScriptArguments {skillId:string;path:string;inputArtifactIds?:string[]}
export async function resolveSkillScript(db:PoolClient,taskId:string,operationId:string,args:SkillScriptArguments):Promise<SkillScriptPackage> {
 const execution=await loadExecution(db,taskId,true);await assertCurrentAuthority(db,execution);
 if(!execution.configuration.capabilities.sandbox.enabled||execution.configuration.capabilities.sandbox.profileId!=="python-analysis-v1"||!execution.configuration.tools.includes("sandbox.analyze"))throw new PlatformError("SKILL_RUNTIME_UNAVAILABLE",403,"Select the approved Python sandbox capability before running a skill script");
 const grant=(await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE",[execution.task.grant_id])).rows[0];
 if(!["skill.read","sandbox.execute","artifact.read","artifact.write"].every(operation=>grant?.operations.includes(operation)))throw new PlatformError("SKILL_SCOPE_DENIED",403,"Skill script execution is outside the current grant");
 if(!execution.configuration.skillIds.includes(args.skillId))throw new PlatformError("SKILL_SCOPE_DENIED",403,"Skill is not selected for this version");
 if(!args.path.startsWith("scripts/")||!args.path.endsWith(".py"))throw new PlatformError("SKILL_LANGUAGE_UNAVAILABLE",400,"Only reviewed Python scripts in scripts/ are supported by the approved runtime");
 const row=(await db.query("SELECT 1 FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND name='skills.run' AND kind='resource' AND state='started'",[operationId,taskId])).rows[0];
 if(!row)throw new PlatformError("SKILL_OPERATION_REQUIRED",403,"A current admitted skill script operation is required");
 const skill=(await loadSkillRevisions(db,execution.task.organization_id,execution.agentId,[args.skillId]))[0]!;
 if(!skill.package||!skill.reviewedDigest)throw new PlatformError("SKILL_PACKAGE_REQUIRED",409,"Select a reviewed package revision");
 const active=(await db.query("SELECT 1 FROM agents_platform.operations WHERE task_id=$1 AND name='skills.activate' AND state='completed' AND output->>'skillId'=$2 AND output->'evidence'->>'packageDigest'=$3",[taskId,skill.id,skill.contentDigest])).rowCount;
 if(!active)throw new PlatformError("SKILL_ACTIVATION_REQUIRED",409,"Activate the reviewed skill before running its script");
 const file=readSkillPackageFile(skill.package,args.path,skill.reviewedDigest);
 if(Buffer.byteLength(file.content)>16384)throw new PlatformError("SKILL_SCRIPT_LIMIT",413,"Python scripts must fit the approved runtime code limit");
 const evidence:SkillFileEvidence=file.evidence;
 await db.query(`INSERT INTO agents_platform.skill_script_executions(operation_id,task_id,organization_id,agent_id,skill_revision_id,package_digest,script_path,script_digest)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(operation_id) DO NOTHING`,[operationId,taskId,execution.task.organization_id,execution.agentId,skill.id,evidence.packageDigest,evidence.path,evidence.contentDigest]);
 const recorded=(await db.query("SELECT * FROM agents_platform.skill_script_executions WHERE operation_id=$1",[operationId])).rows[0];
 if(recorded.task_id!==taskId||recorded.skill_revision_id!==skill.id||recorded.package_digest!==evidence.packageDigest||recorded.script_path!==evidence.path||recorded.script_digest!==evidence.contentDigest)throw new PlatformError("SKILL_SCRIPT_CONFLICT",409,"Script operation identity has changed");
 return {reference:{skillId:skill.id,revision:skill.revision,path:evidence.path,packageDigest:evidence.packageDigest,contentDigest:evidence.contentDigest},files:skill.package.files.map(file=>({path:file.path,content:Buffer.from(file.content,"base64")}))};
}
