import type { Pool,PoolClient } from 'pg';
import type { AdmissionAuthority } from '../../contracts/contracts';
import { PlatformError } from '../../contracts/contracts';
import type { Execution } from '../../contracts/execution';
import type { VersionRecord } from "../../contracts/records";

type Db=Pool|PoolClient;
function denied():never {throw new PlatformError('AUTOMATION_AUTHORITY_DENIED',403,'Automation access is unavailable');}
export async function resolveAutomationOwner(db:Db,organizationId:string,principal:AdmissionAuthority['principal']):Promise<string> {
 if(principal.kind!=='automation')return denied();
 const row=(await db.query(`SELECT a.owner_account_id FROM agents_platform.automations a
 JOIN agents_platform.memberships m ON m.organization_id=a.organization_id AND m.account_id=a.owner_account_id AND m.revoked_at IS NULL
 WHERE a.id=$1 AND a.organization_id=$2 AND a.owner_account_id=$3 FOR SHARE OF a,m`,[principal.id,organizationId,principal.ownerAccountId])).rows[0];
 if(!row)return denied();return row.owner_account_id;
}
export async function assertAutomationAdmission(db:Db,authority:AdmissionAuthority,version:VersionRecord):Promise<void> {
 const p=authority.principal;if(p.kind!=='automation'||authority.product!=='agents'||authority.callerClientId!=='agents-automation'||authority.resourceId!==p.id)return denied();
 await resolveAutomationOwner(db,authority.organizationId,p);
 const row=(await db.query(`SELECT r.version_id,r.configuration FROM agents_platform.automations a
 JOIN agents_platform.automation_revisions r ON r.automation_id=a.id AND r.revision=a.revision
 WHERE a.id=$1 AND a.organization_id=$2 AND a.state='active' FOR SHARE OF a`,[p.id,authority.organizationId])).rows[0];
 if(!row||row.version_id!==version.id||Date.parse(row.configuration.expiresAt)<=Date.now()||version.configuration.memory.enabled)return denied();
}
export async function assertAutomationAuthority(db:Db,execution:Execution):Promise<void> {
 const {task}=execution,p=task.principal;if(p.kind!=='automation')return denied();
 await resolveAutomationOwner(db,task.organization_id,p);
 const row=(await db.query(`SELECT a.state,r.version_id,r.configuration,t.version_id AS root_version FROM agents_platform.automations a
 JOIN agents_platform.automation_occurrences o ON o.automation_id=a.id AND o.task_id=$2 AND o.status='accepted'
 JOIN agents_platform.automation_revisions r ON r.automation_id=a.id AND r.revision=o.revision
 JOIN agents_platform.tasks t ON t.id=o.task_id
 WHERE a.id=$1 AND a.organization_id=$3 FOR SHARE OF a`,[p.id,task.root_task_id,task.organization_id])).rows[0];
 if(!row||row.state==='revoked'||row.version_id!==row.root_version||Date.parse(row.configuration.expiresAt)<=Date.now()||execution.configuration.memory.enabled)return denied();
}
export async function resolveAutomationReviewer(db:Db,organizationId:string,rootTaskId:string):Promise<string> {
 const row=(await db.query(`SELECT r.configuration->>'reviewerAccountId' AS reviewer FROM agents_platform.automation_occurrences o
 JOIN agents_platform.automations a ON a.id=o.automation_id JOIN agents_platform.automation_revisions r ON r.automation_id=o.automation_id AND r.revision=o.revision
 WHERE o.task_id=$1 AND a.organization_id=$2`,[rootTaskId,organizationId])).rows[0];
 if(!row?.reviewer)return denied();return row.reviewer;
}
