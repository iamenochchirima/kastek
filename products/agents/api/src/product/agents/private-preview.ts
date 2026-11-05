import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { executionGrantSchema, PlatformError, assertRuntimeAvailable, connectedToolAuthorityIds, sourceAuthorityIds, type AgentConfiguration } from "../../contracts/contracts";
import type { VersionRecord } from "../../contracts/records";
import { contextGrantCeiling } from "../../execution/models/settings";
import { assertCurrentEvidence, assertDelegationInputEvidence, taskEvidenceManifest } from "../../execution/context/evidence";
import { projectRecipientText, taskRecipientTextScope } from "../../execution/context/recipient-text";
import { transaction } from "../../infrastructure/database";
import { operationsForConfiguration } from "../automations/automations";
import { PlatformStore } from "./store";
import { assertMcpJobAuthority, assertMcpTaskAuthority } from "../../infrastructure/mcp-job-authority";

type Scope = { accountId:string; organizationId:string; connectionId?:string };

/** Private preview uses the ordinary runtime but only admits model and approved-knowledge operations. */
export class PrivatePreview {
  private readonly store: PlatformStore;
  constructor(private readonly pool:Pool, private readonly assertServices:(configuration:AgentConfiguration)=>Promise<void>) {
    this.store = new PlatformStore(pool);
  }

  async start(scope:Scope, raw:unknown) {
    const input=z.strictObject({agentId:z.uuid(), message:z.string().trim().min(1).max(65536), requestId:z.uuid()}).parse(raw);
    return transaction(this.pool,async db=>{
      if (!(await db.query("SELECT 1 FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId])).rowCount) throw new PlatformError("ACCESS_DENIED",403,"Access denied");
      const user=(await db.query(`SELECT a.id,a.issuer,a.subject FROM agents_platform.accounts a JOIN agents_platform.memberships m ON m.account_id=a.id
        WHERE m.organization_id=$1 AND a.id=$2 AND m.revoked_at IS NULL FOR SHARE OF m`,[scope.organizationId,scope.accountId])).rows[0];
      if(!user) throw new PlatformError("ACCESS_DENIED",403,"Access denied");
      if(scope.connectionId)await assertMcpJobAuthority(db,{mcp_connection_id:scope.connectionId,organization_id:scope.organizationId,account_id:scope.accountId});
      const existing=(await db.query(`SELECT id,state,input,principal,execution_purpose FROM agents_platform.tasks
        WHERE product='agents' AND organization_id=$1 AND caller_client_id='agents-execution' AND resource_id=$2 AND request_key=$3`,
        [scope.organizationId,input.agentId,input.requestId])).rows[0];
      if(existing) {
        const provenance=(await db.query("SELECT connection_id FROM agents_platform.mcp_preview_provenance WHERE task_id=$1",[existing.id])).rows[0];
        if((provenance?.connection_id??null)!==(scope.connectionId??null))throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"The request identifier was used for another connection");
        if(existing.execution_purpose!=="private_preview_v1" || existing.input!==input.message || existing.principal?.kind!=="human" ||
          existing.principal.issuer!==user.issuer || existing.principal.subject!==user.subject)
          throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"The request identifier was used for another task");
        return {id:existing.id,state:existing.state,replayed:true,limitations:"Preview can read approved knowledge. External actions and other tools are unavailable."};
      }
      const version=(await db.query<VersionRecord>(`SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a
        ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.agent_id=$2 ORDER BY v.number DESC LIMIT 1`,[scope.organizationId,input.agentId])).rows[0];
      if(!version) throw new PlatformError("CONFIGURATION_UNAVAILABLE",409,"Save the agent settings before testing");
      assertRuntimeAvailable(version.configuration);
      await this.assertServices(version.configuration);
      const authority={product:"agents" as const,organizationId:scope.organizationId,resourceId:input.agentId,callerClientId:"agents-execution",
        principal:{kind:"human" as const,issuer:user.issuer as string,subject:user.subject as string}};
      const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:operationsForConfiguration(version.configuration,true),
        sourceRevisionIds:sourceAuthorityIds(version.configuration),connectedToolBindingIds:connectedToolAuthorityIds(version.configuration),
        maxInputBytes:version.configuration.model.maxInputBytes,maxOutputTokens:version.configuration.model.maxOutputTokens,
        maxContextTokens:contextGrantCeiling(version.configuration),expiresAt:new Date(Date.now()+30*60_000).toISOString(),revokedAt:null});
      await this.store.createGrantInTransaction(db,{accountId:scope.accountId,grant});
      const result=await this.store.admitPrivatePreviewInTransaction(db,{authority,grantId:grant.id,versionId:version.id,input:input.message,requestKey:input.requestId,configurationMode:"current"});
      if(scope.connectionId)await db.query("INSERT INTO agents_platform.mcp_preview_provenance(task_id,connection_id,account_id,organization_id) VALUES($1,$2,$3,$4)",[result.task.id,scope.connectionId,scope.accountId,scope.organizationId]);
      return {id:result.task.id,state:result.task.state,replayed:result.replayed,limitations:"Preview can read approved knowledge. External actions and other tools are unavailable."};
    });
  }

  async get(scope:Scope, raw:unknown) {
    const {taskId}=z.strictObject({taskId:z.uuid()}).parse(raw);
    const row=(await this.pool.query(`SELECT t.id,t.state,t.output,t.error_code FROM agents_platform.tasks t
      JOIN agents_platform.accounts a ON a.id=$2 AND a.issuer=t.principal->>'issuer' AND a.subject=t.principal->>'subject'
      JOIN agents_platform.memberships m ON m.account_id=a.id AND m.organization_id=t.organization_id AND m.revoked_at IS NULL
      JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.deleted_at IS NULL
      WHERE t.id=$1 AND t.organization_id=$3 AND t.execution_purpose='private_preview_v1' AND t.parent_task_id IS NULL`,[taskId,scope.accountId,scope.organizationId])).rows[0];
    if(!row) throw new PlatformError("NOT_FOUND",404,"Preview not found");
    await assertMcpTaskAuthority(this.pool,taskId);
    let output:string|null=null;
    if(typeof row.output==='string') try {
      await assertDelegationInputEvidence(this.pool,taskId);
      await assertCurrentEvidence(this.pool,taskId,await taskEvidenceManifest(this.pool,taskId),{requireActiveTask:false});
      output=projectRecipientText(row.output,await taskRecipientTextScope(this.pool,taskId,[row.output]));
    } catch(error) { if(!(error instanceof PlatformError)) throw error; }
    return {id:row.id,state:row.state,output,errorCode:row.error_code,limitations:"Preview can read approved knowledge. External actions and other tools are unavailable."};
  }
}
