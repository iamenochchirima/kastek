import type { KeyObject } from "node:crypto";
import { jwtVerify } from "jose";
import type { Pool, PoolClient } from "pg";
import { agentConfigurationSchema, assertGrantAuthority, executionGrantSchema, PlatformError, requestDigest } from "../../contracts/contracts";
import { productAssertionSchema } from "../../contracts/products";
import type { AdmitTaskInput, TaskRecord, VersionRecord } from "../../contracts/records";
import { transaction } from "../../infrastructure/database";

export interface ProductExecutionTrust {
  product: "growth" | "agencies"; clientId: string; issuer: string; actorIssuer: string;
  publicKey: CryptoKey | KeyObject | Uint8Array;
}
export interface ProductExecutionPorts {
  admit(db: PoolClient, input: AdmitTaskInput): Promise<{ task: TaskRecord; replayed: boolean }>;
}

/** Installed by a trusted composition root, never constructed from model or request configuration. */
export class ProductExecutionAdapter {
  constructor(private readonly pool: Pool, private readonly trust: ProductExecutionTrust, private readonly ports: ProductExecutionPorts) {}
  async admit(assertion: string, input: { input: string; requestKey: string }) {
    let claims;
    try {
      const verified = await jwtVerify(assertion, this.trust.publicKey, { issuer: this.trust.issuer, audience: "agents-execution", algorithms: ["RS256"] });
      claims = productAssertionSchema.parse(verified.payload);
    } catch { throw new PlatformError("PRODUCT_ASSERTION_INVALID",401,"The product assertion is invalid"); }
    if(claims.product!==this.trust.product || claims.actorIssuer!==this.trust.actorIssuer || (claims.exp-claims.iat>300 || claims.exp<=claims.iat) ||
      claims.iat>Date.now()/1000+5 || claims.inputDigest!==requestDigest(input.input)) {
      throw new PlatformError("PRODUCT_ASSERTION_SCOPE_DENIED",403,"The product assertion does not cover this input");
    }
    const assertionDigest=requestDigest(claims);
    return transaction(this.pool, async db => {
      const tenant=(await db.query(`SELECT organization_id FROM agents_platform.product_execution_tenants
        WHERE product=$1 AND tenant_id=$2 AND client_id=$3 AND issuer=$4 AND revoked_at IS NULL FOR SHARE`,
      [claims.product,claims.tenantId,this.trust.clientId,this.trust.issuer])).rows[0];
      if(!tenant) throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",403,"The product tenant is unavailable");
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[tenant.organization_id]);
      const version=(await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND id=$2 FOR SHARE",[tenant.organization_id,claims.versionId])).rows[0];
      if(!version) throw new PlatformError("PRODUCT_VERSION_UNAVAILABLE",403,"The version is outside this product tenant");
      const config=agentConfigurationSchema.parse(version.configuration);
      // Rich product tools require their own scoped resource contracts before integration is enabled.
      if(config.memory.enabled || config.skillIds.length || config.connectedToolBindingIds.length || config.capabilities.delegation.enabled ||
        config.capabilities.sandbox.enabled || config.capabilities.workflows.enabled || config.tools.some(tool=>!tool.startsWith("knowledge."))) {
        throw new PlatformError("PRODUCT_CAPABILITY_UNAVAILABLE",503,"This delegated product capability is unavailable");
      }
      const sources=(await db.query(`SELECT r.id FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id
        JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[]) AND s.state='active' AND s.visibility='public' AND p.state='approved' FOR SHARE OF s,p`,[tenant.organization_id,config.sourceRevisionIds])).rows;
      if(sources.length!==config.sourceRevisionIds.length) throw new PlatformError("PRODUCT_SOURCE_UNAVAILABLE",403,"The approved product knowledge is unavailable");
      const authority={ product:claims.product,organizationId:tenant.organization_id,resourceId:claims.resourceId,callerClientId:this.trust.clientId,
        principal:{kind:"human" as const,issuer:claims.actorIssuer,subject:claims.sub} };
      const grant=executionGrantSchema.parse({...authority,id:claims.jti,versionId:version.id,operations:claims.operations,sourceRevisionIds:claims.sourceRevisionIds,
        maxInputBytes:claims.maxInputBytes,maxOutputTokens:claims.maxOutputTokens,rootTokenLimit:claims.rootTokenLimit,expiresAt:new Date(claims.exp*1000).toISOString(),revokedAt:null});
      assertGrantAuthority(grant,authority,version.id,config);
      const existing=(await db.query("SELECT assertion_digest FROM agents_platform.product_execution_authorities WHERE grant_id=$1",[grant.id])).rows[0];
      if(existing && existing.assertion_digest!==assertionDigest) throw new PlatformError("PRODUCT_ASSERTION_CONFLICT",409,"The product assertion identity was reused");
      if(!existing) {
        await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,
          max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at,source_revision_ids,connected_tool_binding_ids)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[grant.id,grant.product,grant.organizationId,grant.resourceId,grant.callerClientId,
          grant.principal,grant.versionId,JSON.stringify(grant.operations),grant.maxInputBytes,grant.maxOutputTokens,grant.maxContextTokens,grant.rootTokenLimit,grant.expiresAt,grant.sourceRevisionIds,grant.connectedToolBindingIds]);
        await db.query(`INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest)
          VALUES($1,$2,$3,$4,$5,$6)`,[grant.id,grant.product,grant.organizationId,this.trust.clientId,this.trust.issuer,assertionDigest]);
      }
      return this.ports.admit(db,{authority,grantId:grant.id,versionId:version.id,requestKey:input.requestKey,input:input.input});
    });
  }
}
