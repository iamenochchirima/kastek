import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { requireMemoryAccess } from "../../execution/memory/access";
import { transaction } from "../../infrastructure/database";
import { parseSkillPackage, readSkillPackageFile, type SkillPackage } from "../../capabilities/skills/package";
import { CURATED_SKILL_PUBLISHER, curatedSkillCatalog, curatedSkillPackage } from "../../capabilities/skills/curated";
import { acquireSkillRepository,type SkillRepositoryOptions,type SkillRepositorySource } from "../../capabilities/skills/repository";
import { skillFamilyId } from "../../contracts/skills";
import type { SkillRequirements } from "../../capabilities/skills/requirements";
import { isProductResourceScope, requireProductResourceAccess, resourceAccountId, resourceService, resourceMatchesScope, type AgentResourceScope } from "../../contracts/resource-scope";

async function requireSkillAccess(db: PoolClient, scope: AgentResourceScope, owner = false) {
  if (isProductResourceScope(scope)) return requireProductResourceAccess(db, scope, owner);
  await requireMemoryAccess(db, scope);
  if (owner && !(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role IN ('owner','admin') AND revoked_at IS NULL FOR SHARE", [scope.organizationId, scope.accountId])).rowCount) {
    throw new PlatformError("ACCESS_DENIED", 403, "An owner or admin must manage skill packages");
  }
}

export interface SkillPackageSummary {
  id: string; familyId:string; name: string; description: string; revision: number; contentDigest: string;
  compatibility: string | null; reviewState: "pending" | "reviewed"; createdAt: string;
  files: { path: string; size: number; contentDigest: string }[];
  publisher: { id: string; name: string; verified: boolean };
  source: { kind: "private"; slug: null } | { kind: "curated"; slug: string } | ({kind:"repository";slug:null}&SkillRepositorySource);
  requires:SkillRequirements;state:"enabled"|"disabled"|"removed";generation:number;
}
const query = `SELECT s.*,p.files,p.compatibility,p.total_bytes,p.source_kind,p.source_slug,r.content_digest AS reviewed_digest,
  coalesce(st.state,'enabled') AS installation_state,coalesce(st.generation,1) AS installation_generation,
  rs.repository,rs.commit_sha,rs.package_path,rs.tree_sha
  FROM agents_platform.skill_revisions s JOIN agents_platform.skill_packages p ON p.skill_revision_id=s.id
  LEFT JOIN agents_platform.skill_package_reviews r ON r.skill_revision_id=s.id
  LEFT JOIN agents_platform.skill_installation_states st ON st.skill_revision_id=s.id
  LEFT JOIN agents_platform.skill_repository_sources rs ON rs.skill_revision_id=s.id
  WHERE s.organization_id=$1 AND s.agent_id=$2`;
function pkg(row: Record<string, any>): SkillPackage {
  const result = parseSkillPackage({ files: row.files.map((file: any) => ({ path: file.path, content: file.content, encoding: file.encoding })) });
  if (result.contentDigest !== row.content_digest) throw new PlatformError("SKILL_PACKAGE_CORRUPT", 409, "Skill package content has changed");
  return result;
}
function summary(row: Record<string, any>): SkillPackageSummary {
  const current = pkg(row);
  return { id: row.id, familyId:skillFamilyId({organizationId:row.organization_id,name:current.name,sourceKind:row.source_kind,sourceSlug:row.source_slug,repository:row.repository,packagePath:row.package_path}), name: current.name, description: current.description, revision: row.revision, contentDigest: current.contentDigest,
    compatibility: current.compatibility, reviewState: row.reviewed_digest === current.contentDigest ? "reviewed" : "pending",
    publisher: row.source_kind === "curated" ? CURATED_SKILL_PUBLISHER : { id: row.organization_id, name: "Workspace", verified: false },
    source: row.repository?{kind:"repository",slug:null,repository:row.repository,commit:row.commit_sha,path:row.package_path,tree:row.tree_sha}:row.source_kind === "curated" ? { kind: "curated", slug: row.source_slug } : { kind: "private", slug: null },
    requires:current.requirements,state:row.installation_state,generation:row.installation_generation,
    createdAt: new Date(row.created_at).toISOString(), files: current.files.map(file => ({ path: file.path, size: file.size, contentDigest: file.digest })) };
}
export class SkillPackageStore {
  constructor(readonly pool: Pool,readonly repositoryOptions:SkillRepositoryOptions={}) {}
  private async row(db: PoolClient, scope: AgentResourceScope, id: string) {
    z.uuid().parse(id);
    const row = (await db.query(query + " AND s.id=$3", [scope.organizationId, scope.agentId, id])).rows[0];
    if (!row || isProductResourceScope(scope) && !resourceMatchesScope(row.created_by_service, scope)) throw new PlatformError("NOT_FOUND", 404, "Skill package is unavailable");
    return row;
  }
  async list(scope: AgentResourceScope): Promise<SkillPackageSummary[]> {
    return transaction(this.pool, async db => { await requireSkillAccess(db, scope);
      return (await db.query(query + " AND coalesce(st.state,'enabled')<>'removed' ORDER BY s.name,s.revision DESC LIMIT 200", [scope.organizationId, scope.agentId])).rows
        .filter(row => !isProductResourceScope(scope) || resourceMatchesScope(row.created_by_service, scope)).map(summary); });
  }
  async get(scope: AgentResourceScope, id: string) {
    return transaction(this.pool, async db => { await requireSkillAccess(db, scope); const row = await this.row(db, scope, id);
      return { package: summary(row), body: pkg(row).body }; });
  }
  async import(scope: AgentResourceScope, operationId: string, input: SkillPackage, curatedSlug?: string,repositorySource?:SkillRepositorySource): Promise<SkillPackageSummary> {
    z.string().min(1).max(128).parse(operationId);
    const current = parseSkillPackage({ files: input.files.map(file => ({ path: file.path, content: file.content, encoding: file.encoding })) });
    if (curatedSlug && curatedSkillPackage(curatedSlug).contentDigest !== current.contentDigest) throw new PlatformError("SKILL_PACKAGE_INVALID", 400, "Curated content does not match its published source");
    const requestDigest = createHash("sha256").update(JSON.stringify(["skill-package-import-v1", current.contentDigest, curatedSlug ?? null,...(repositorySource?[repositorySource]:[]),...(isProductResourceScope(scope)?[resourceService(scope)]:[])])).digest("hex");
    return transaction(this.pool, async db => {
      await requireSkillAccess(db, scope, isProductResourceScope(scope));
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`skill:${scope.organizationId}:${scope.agentId}`]);
      const old = (await db.query("SELECT id,request_digest FROM agents_platform.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND operation_id=$3", [scope.organizationId, scope.agentId, operationId])).rows[0];
      if (old) {
        if (old.request_digest !== requestDigest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request key was already used");
        return summary(await this.row(db, scope, old.id));
      }
      const revision = Number((await db.query("SELECT coalesce(max(revision),0)+1 AS next FROM agents_platform.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND name=$3", [scope.organizationId, scope.agentId, current.name])).rows[0].next);
      const id = randomUUID();
      await db.query(`INSERT INTO agents_platform.skill_revisions(id,organization_id,agent_id,created_by,name,description,body,revision,content_digest,operation_id,request_digest,created_by_service)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, scope.organizationId, scope.agentId, resourceAccountId(scope), current.name, current.description, current.body, revision, current.contentDigest, operationId, requestDigest, resourceService(scope)]);
      await db.query("INSERT INTO agents_platform.skill_packages(skill_revision_id,organization_id,agent_id,files,compatibility,total_bytes,source_kind,source_slug,requirements) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb)",
        [id, scope.organizationId, scope.agentId, JSON.stringify(current.files), current.compatibility, current.totalBytes, curatedSlug ? "curated" : "private", curatedSlug ?? null,JSON.stringify(current.requirements)]);
      await db.query("INSERT INTO agents_platform.skill_installation_states(skill_revision_id,organization_id,agent_id,updated_by,updated_by_service) VALUES($1,$2,$3,$4,$5)",[id,scope.organizationId,scope.agentId,resourceAccountId(scope),resourceService(scope)]);
      if(repositorySource)await db.query("INSERT INTO agents_platform.skill_repository_sources(skill_revision_id,organization_id,agent_id,repository,commit_sha,package_path,tree_sha) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [id,scope.organizationId,scope.agentId,repositorySource.repository,repositorySource.commit,repositorySource.path,repositorySource.tree]);
      return summary(await this.row(db, scope, id));
    });
  }
  async importRepository(scope:AgentResourceScope,operationId:string,input:unknown) {
    z.string().min(1).max(128).parse(operationId);
    await transaction(this.pool,db=>requireSkillAccess(db,scope));
    const acquired=await acquireSkillRepository(input,this.repositoryOptions);
    return this.import(scope,operationId,acquired.package,undefined,acquired.source);
  }
  async compare(scope:AgentResourceScope,id:string,candidateId:string) {
    return transaction(this.pool,async db=>{
      await requireSkillAccess(db,scope);const before=await this.row(db,scope,id),after=await this.row(db,scope,candidateId),old=pkg(before),next=pkg(after);
      if(summary(before).familyId!==summary(after).familyId)throw new PlatformError("SKILL_UPDATE_MISMATCH",400,"Compare revisions from the same skill publisher and source");
      const paths=[...new Set([...old.files.map(file=>file.path),...next.files.map(file=>file.path)])].sort();
      const files=paths.flatMap(path=>{const a=old.files.find(file=>file.path===path),b=next.files.find(file=>file.path===path);return a?.digest===b?.digest?[]:[{path,change:!a?"added":!b?"removed":"changed",beforeDigest:a?.digest??null,afterDigest:b?.digest??null,beforeBytes:a?.size??null,afterBytes:b?.size??null}];});
      return {before:summary(before),after:summary(after),files,instructions:{before:old.body,after:next.body},requirements:{before:old.requirements,after:next.requirements}};
    });
  }
  async setState(scope:AgentResourceScope,id:string,raw:unknown) {
    const input=z.strictObject({operationId:z.string().min(1).max(128),expectedGeneration:z.number().int().positive(),state:z.enum(["enabled","disabled","removed"])}).parse(raw);
    const digest=createHash("sha256").update(JSON.stringify({id,...input})).digest("hex");
    return transaction(this.pool,async db=>{
      await requireSkillAccess(db,scope,true);
      await this.row(db,scope,id);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`skill-state:${scope.organizationId}:${scope.agentId}`]);
      const old=(await db.query("SELECT request_digest,result FROM agents_platform.skill_installation_mutations WHERE organization_id=$1 AND agent_id=$2 AND operation_id=$3",[scope.organizationId,scope.agentId,input.operationId])).rows[0];
      if(old){if(old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request key was already used");return old.result as SkillPackageSummary;}
      await db.query("INSERT INTO agents_platform.skill_installation_states(skill_revision_id,organization_id,agent_id,updated_by,updated_by_service) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",[id,scope.organizationId,scope.agentId,resourceAccountId(scope),resourceService(scope)]);
      const current=(await db.query("SELECT state,generation FROM agents_platform.skill_installation_states WHERE skill_revision_id=$1 FOR UPDATE",[id])).rows[0];
      if(current.generation!==input.expectedGeneration||current.state==="removed")throw new PlatformError("SKILL_STATE_CONFLICT",409,"Skill installation changed; refresh and try again");
      await db.query("UPDATE agents_platform.skill_installation_states SET state=$2,generation=generation+1,updated_by=$3,updated_by_service=$4,updated_at=now() WHERE skill_revision_id=$1",[id,input.state,resourceAccountId(scope),resourceService(scope)]);
      const result=summary(await this.row(db,scope,id));
      await db.query("INSERT INTO agents_platform.skill_installation_mutations(organization_id,agent_id,operation_id,skill_revision_id,request_digest,result) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[scope.organizationId,scope.agentId,input.operationId,id,digest,JSON.stringify(result)]);return result;
    });
  }
  async curated(scope: AgentResourceScope) {
    return transaction(this.pool, async db => { await requireSkillAccess(db, scope); return curatedSkillCatalog(); });
  }
  async installCurated(scope: AgentResourceScope, slug: string, operationId: string): Promise<SkillPackageSummary> {
    const current = await this.import(scope, operationId, curatedSkillPackage(slug), slug);
    const owner = isProductResourceScope(scope) ? { rowCount: scope.authority === "manage" ? 1 : 0 } : await this.pool.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role IN ('owner','admin') AND revoked_at IS NULL", [scope.organizationId, scope.accountId]);
    return owner.rowCount ? this.review(scope, current.id, current.contentDigest) : current;
  }
  async review(scope: AgentResourceScope, id: string, contentDigest: string): Promise<SkillPackageSummary> {
    z.string().regex(/^[a-f0-9]{64}$/).parse(contentDigest);
    return transaction(this.pool, async db => {
      await requireSkillAccess(db, scope, true);
      const row = await this.row(db, scope, id), current = pkg(row);
      if(row.installation_state==="removed")throw new PlatformError("SKILL_STATE_CONFLICT",409,"Removed skill installations cannot be reviewed");
      if (contentDigest !== current.contentDigest) throw new PlatformError("SKILL_REVIEW_REQUIRED", 409, "Review requires the exact package digest");
      await db.query(`INSERT INTO agents_platform.skill_package_reviews(skill_revision_id,organization_id,agent_id,content_digest,reviewed_by,reviewed_by_service)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(skill_revision_id) DO NOTHING`, [id, scope.organizationId, scope.agentId, contentDigest, resourceAccountId(scope), resourceService(scope)]);
      return summary(await this.row(db, scope, id));
    });
  }
  async file(scope: AgentResourceScope, id: string, path: string) {
    return transaction(this.pool, async db => { await requireSkillAccess(db, scope); const row = await this.row(db, scope, id);
      // Management preview is permitted before review; runtime loading requires the persisted review digest.
      return readSkillPackageFile(pkg(row), path, row.content_digest); });
  }
}
