import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { GrowthAgentCommand, GrowthAgentFeatureId, GrowthAgentResourceInventory, GrowthAgentResourceOperation, GrowthAgentResourcePreview, GrowthAgentPublication } from "@kasitek-labs/contracts";
import { agentConfigurationSchema, PlatformError, requestDigest } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { KnowledgeStore } from "../../platform/knowledge";
import { PostgresKnowledgeObjectStore } from "../../platform/knowledge";
import { SkillPackageStore } from "../agents/skill-package-store";
import { parseSkillPackage, parseSkillZip } from "../../capabilities/skills/package";
import { curatedSkillCatalog, curatedSkillPackage } from "../../capabilities/skills/curated";
import { configurationSkillAuthority, missingSkillRequirements } from "../../capabilities/skills/requirement-authority";
import { requireProductResourceAccess, type ProductResourceScope } from "../../contracts/resource-scope";
import { validateProductNativeSelection, pinProductCompositionSources } from "../../capabilities/products/native-selection";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { assertGrowthConfigurationPreservingConnections } from "./growth-features";
import { growthConnectedPins,pinGrowthConnectedTools } from "./growth-connected-pins";
import { textDigest } from "../../contracts/source-contracts";
import { refreshGrowthManagedRoster } from "./growth-managed-roster";
type NativeInventory = [Awaited<ReturnType<KnowledgeStore["list"]>>, Awaited<ReturnType<SkillPackageStore["list"]>>];

export class GrowthResourceService {
  readonly knowledge: KnowledgeStore; readonly skills: SkillPackageStore;
  constructor(readonly pool: Pool) {
    this.knowledge = new KnowledgeStore(pool, new PostgresKnowledgeObjectStore(pool)); this.skills = new SkillPackageStore(pool);
  }
  async inventory(scope: ProductResourceScope, featureId: GrowthAgentFeatureId, db: Pool | PoolClient = this.pool, native?: NativeInventory): Promise<GrowthAgentResourceInventory> {
    await requireProductResourceAccess(db, scope);
    const feature = (await db.query(`SELECT f.revision,v.configuration FROM agents_platform.product_execution_features f
      JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.agent_id=$2 AND f.feature_id=$3`, [scope.tenantId, scope.agentId, featureId])).rows[0];
    if (!feature) throw new PlatformError("PRODUCT_RESOURCE_DENIED", 403, "The product feature is unavailable");
    const configuration = agentConfigurationSchema.parse(feature.configuration), [sources, skills] = native ?? await Promise.all([this.knowledge.list(scope), this.skills.list(scope)]);
    const permissions = [...configurationSkillAuthority(configuration), "product.read", ...(configuration.productBindings.some(binding => binding.policy.effect === "reviewed_write") ? ["product.write"] : [])];
    return { featureId, revision: feature.revision, sourceRevisionIds: configuration.sourceRevisionIds, skillIds: configuration.skillIds,
      sources: sources.map(({ id, title, generation, state, revisions }) => ({ id, title, generation, state, revisions })),
      skills: skills.map(({ id, name, description, revision, contentDigest, reviewState, state, generation, files, requires }) => ({ id, name, description, revision, contentDigest, reviewState, state, generation, files, missing: missingSkillRequirements(requires, configuration, [], permissions) })),
      curatedSkills: curatedSkillCatalog().map(({ slug, name, description }) => ({ slug, name, description })),
      supportedFormats: { sources: ["text/plain", "text/markdown"], skills: ["files", "zip", "curated"] } };
  }
  async execute(scope: ProductResourceScope, command: GrowthAgentCommand<GrowthAgentResourceOperation>, publication: GrowthAgentPublication, db?: PoolClient): Promise<GrowthAgentResourceInventory | GrowthAgentResourcePreview> {
    await requireProductResourceAccess(this.pool, scope, command.operation !== "resources.list" && command.operation !== "resources.preview");
    const input = command.input;
    const native: NativeInventory | undefined = command.operation === "resources.select" ? await Promise.all([this.knowledge.list(scope), this.skills.list(scope)]) : undefined;
    switch (command.operation) {
      case "resources.list": return this.inventory(scope, input.featureId);
      case "resources.preview": {
        if (command.input.kind === "source") {
          const preview = await this.knowledge.preview(scope, command.input.sourceId, command.input.revisionId);
          return { kind: "source", title: "Knowledge source", content: preview.text, contentDigest: textDigest(preview.text) };
        }
        const preview = await this.skills.file(scope, command.input.skillId, command.input.path ?? "SKILL.md");
        return { kind: "skill", title: command.input.path ?? "SKILL.md", content: preview.content, contentDigest: preview.evidence.contentDigest, path: preview.evidence.path };
      }
      case "sources.import": await this.knowledge.admitText(scope, { operationId: command.requestId, title: command.input.title, text: command.input.text, contentType: command.input.contentType }); break;
      case "sources.review": await this.knowledge.setPolicy(scope, command.input.sourceId, { operationId: command.requestId, action: "approve", revisionId: command.input.revisionId, expectedGeneration: command.input.expectedGeneration }); break;
      case "sources.state": await this.knowledge.setPolicy(scope, command.input.sourceId, { operationId: command.requestId, action: "withdraw", expectedGeneration: command.input.expectedGeneration }); break;
      case "skills.import": {
        const source = command.input.package;
        if (source.source === "curated") await this.skills.import(scope, command.requestId, curatedSkillPackage(source.slug), source.slug);
        else if (source.source === "files") await this.skills.import(scope, command.requestId, parseSkillPackage({ files: source.files }));
        else {
          const bytes = Buffer.from(source.contentBase64, "base64");
          if (bytes.toString("base64") !== source.contentBase64) throw new PlatformError("SKILL_PACKAGE_INVALID", 400, "The skill archive content is invalid");
          await this.skills.import(scope, command.requestId, await parseSkillZip(bytes));
        }
        break;
      }
      case "skills.review": await this.skills.review(scope, command.input.skillId, command.input.contentDigest); break;
      case "skills.state": await this.skills.setState(scope, command.input.skillId, { operationId: command.requestId, expectedGeneration: command.input.expectedGeneration, state: command.input.state }); break;
      case "resources.select": await this.select(scope, command.input, publication, db); break;
    }
    return this.inventory(scope, command.input.featureId, db, native);
  }
  private async select(scope: ProductResourceScope, input: Extract<GrowthAgentCommand, { operation: "resources.select" }>["input"], publication: GrowthAgentPublication, active?: PoolClient) {
    const perform = async (db: PoolClient) => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      await requireProductResourceAccess(db, scope, true);
      const previous = (await db.query(`SELECT f.*,v.configuration FROM agents_platform.product_execution_features f
        JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.agent_id=$2 AND f.feature_id=$3 FOR UPDATE OF f`, [scope.tenantId, scope.agentId, input.featureId])).rows[0];
      if (!previous || previous.revision !== input.expectedRevision) throw new PlatformError("CONFIGURATION_CHANGED", 409, "Agent settings changed. Refresh and try again.");
      const configuration = agentConfigurationSchema.parse(previous.configuration);
      configuration.sourceRevisionIds = input.sourceRevisionIds; configuration.skillIds = input.skillIds;
      configuration.tools = configuration.tools.filter(tool => !tool.startsWith("knowledge."));
      if (configuration.sourceRevisionIds.length) configuration.tools.push("knowledge.search", "knowledge.read");
      assertGrowthConfigurationPreservingConnections(configuration, agentConfigurationSchema.parse(previous.configuration), publication);
      await validateProductNativeSelection(db, scope, configuration);
      if (requestDigest(configuration) === requestDigest(previous.configuration)) return;
      const connected=await growthConnectedPins(db,scope.organizationId,previous.version_id,configuration);
      const versionId = randomUUID(), number = previous.revision + 1, service = { product: "growth", clientId: scope.service.clientId, issuer: scope.service.issuer, actor: scope.actor };
      const updated=await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1 AND draft=$4::jsonb", [scope.agentId, configuration, number, previous.configuration]);
      if(!updated.rowCount)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Refresh and try again.");
      await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
        VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`, [versionId, scope.organizationId, scope.agentId, number, configuration, service, JSON.stringify(publishedToolBindings(configuration)), compilePublishedComposition(configuration, connected.direct)]);
      await pinGrowthConnectedTools(db,scope.organizationId,versionId,connected.ids);
      await db.query(`UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,
        managed_configuration_digest=CASE WHEN managed_configuration_digest=$5 THEN $6 ELSE managed_configuration_digest END,updated_at=now()
        WHERE product='growth' AND tenant_id=$1 AND feature_id=$2`, [scope.tenantId, input.featureId, versionId, number, requestDigest(previous.configuration), requestDigest(configuration)]);
      await pinProductCompositionSources(db, scope, versionId, configuration);
      if (input.featureId !== "assistant") await refreshGrowthManagedRoster(db, scope.tenantId, service);
    };
    if (active) await perform(active); else await transaction(this.pool, perform);
  }
}
