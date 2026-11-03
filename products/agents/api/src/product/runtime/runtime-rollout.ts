import type { Pool, PoolClient } from "pg";
import { agentConfigurationSchema, PlatformError, requestDigest, type AgentConfiguration } from "../../contracts/contracts";
import { capabilityBindingSchema, type CapabilityBinding } from "../../contracts/capability-catalog";
import { SHARED_HARNESS_RELEASE, SHARED_WORKFLOW_NAME } from "../../contracts/execution";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { transaction } from "../../infrastructure/database";
export const runtimeRolloutRevision = "agents-runtime-rollout-v1";
type Configuration = AgentConfiguration;
type Version = {
  id: string;
  organization_id: string;
  agent_id: string;
  number: number;
  draft_revision: number;
  execution_kind: string;
  configuration: Configuration;
  tool_bindings: unknown;
  effective_composition: unknown;
  created_by: string | null;
  created_by_service: unknown;
  created_at: Date;
};
type Agent = {
  id: string;
  organization_id: string;
  draft: unknown;
  draft_revision: number;
};
type Target = {
  kind: "definition" | "website" | "channel" | "product" | "automation";
  id: string;
  versionId: string;
  revision?: number;
  product?: string;
  tenantId?: string;
  configuration?: Record<string, unknown>;
  managedDigest?: string | null;
  managedBaseline?: Record<string, unknown> | null;
};
type Change = {
  previous: Version;
  id: string;
  number: number;
  draftRevision: number;
  configuration: Configuration;
  toolBindings: ReturnType<typeof publishedToolBindings>;
  composition: ReturnType<typeof compilePublishedComposition>;
};
interface Plan {
  agents: Agent[];
  targets: Target[];
  changes: Change[];
  digest: string;
  busyTasks: string[];
  excluded: Record<string, number>;
}
export interface RuntimeRolloutPreview {
  revision: string;
  runtime: {
    release: string;
    workflow: string;
  };
  digest: string;
  versions: {
    agentId: string;
    previousVersionId: string;
    versionId: string;
    number: number;
  }[];
  targets: {
    kind: Target["kind"];
    id: string;
    product?: string;
    tenantId?: string;
    previousVersionId: string;
    versionId: string;
  }[];
  busyTaskIds: string[];
  excluded: Record<string, number>;
}
const currentRuntime = { release: SHARED_HARNESS_RELEASE, workflow: SHARED_WORKFLOW_NAME };
const equal = (left: unknown, right: unknown) => requestDigest(left ?? null) === requestDigest(right ?? null);
function stableId(value: unknown): string { const hash = requestDigest(value); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }
function remapBaseline(baseline: Record<string, unknown> | null | undefined, mapped: ReadonlyMap<string, Change>): Record<string, unknown> | null {
  if (!baseline)
    return null;
  const copy = structuredClone(baseline);
  const delegation = copy.delegation as {
    enabled?: boolean;
    bindings?: {
      versionId: string;
      versionNumber?: number;
    }[];
  } | undefined;
  if (delegation?.enabled)
    for (const binding of delegation.bindings ?? []) {
      const change = mapped.get(binding.versionId);
      if (change) {
        binding.versionId = change.id;
        if (binding.versionNumber !== undefined)
          binding.versionNumber = change.number;
      }
    }
  return copy;
}
function changed(): never { throw new PlatformError("RUNTIME_ROLLOUT_CHANGED", 409, "Active agent configuration changed. Preview the rollout again."); }
/** The operator uses the same publication compiler. This never creates business permissions. */
async function plan(db: PoolClient, lock: boolean): Promise<Plan> {
  if (lock) {
    await db.query("SELECT pg_advisory_xact_lock(19871017, 3)");
    await db.query("SELECT id FROM agents_platform.organizations ORDER BY id FOR UPDATE");
  }
  const agents = (await db.query<Agent>(`SELECT id,organization_id,draft,draft_revision FROM agents_platform.agents WHERE deleted_at IS NULL ORDER BY organization_id,id${lock ? " FOR UPDATE" : ""}`)).rows;
  const versions = (await db.query<Version>(`SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE a.deleted_at IS NULL ORDER BY v.created_at,v.agent_id,v.number`)).rows;
  const byId = new Map(versions.map(version => [version.id, version]));
  const targets: Target[] = [];
  for (const agent of agents) {
    const latest = versions.filter(version => version.agent_id === agent.id).sort((a, b) => b.number - a.number)[0];
    if (latest)
      targets.push({ kind: "definition", id: agent.id, versionId: latest.id });
  }
  const websites = (await db.query(`SELECT d.id,d.version_id FROM agents_platform.website_deployments d JOIN agents_platform.agents a ON a.id=d.agent_id AND a.organization_id=d.organization_id WHERE a.deleted_at IS NULL AND d.revoked_at IS NULL AND NOT d.paused AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.deployment_id=d.id) ORDER BY d.id${lock ? " FOR UPDATE OF d" : ""}`)).rows;
  targets.push(...websites.map(row => ({ kind: "website" as const, id: row.id, versionId: row.version_id })));
  const channels = (await db.query(`SELECT d.id,d.version_id,d.revision FROM agents_platform.channel_deployments d JOIN agents_platform.agents a ON a.id=d.agent_id AND a.organization_id=d.organization_id WHERE a.deleted_at IS NULL AND d.state='active' ORDER BY d.id${lock ? " FOR UPDATE OF d" : ""}`)).rows;
  targets.push(...channels.map(row => ({ kind: "channel" as const, id: row.id, versionId: row.version_id, revision: row.revision })));
  const products = (await db.query(`SELECT f.product,f.tenant_id,f.feature_id,f.version_id,f.revision,f.managed_configuration_digest,f.managed_capability_baseline FROM agents_platform.product_execution_features f JOIN agents_platform.agents a ON a.id=f.agent_id AND a.organization_id=f.organization_id JOIN agents_platform.product_execution_tenants t ON t.product=f.product AND t.tenant_id=f.tenant_id WHERE a.deleted_at IS NULL AND f.enabled AND t.revoked_at IS NULL ORDER BY f.product,f.tenant_id,f.feature_id${lock ? " FOR UPDATE OF f" : ""}`)).rows;
  targets.push(...products.map(row => ({ kind: "product" as const, id: row.feature_id, product: row.product, tenantId: row.tenant_id, versionId: row.version_id, revision: row.revision, managedDigest: row.managed_configuration_digest, managedBaseline: row.managed_capability_baseline })));
  const automations = (await db.query(`SELECT a.id,a.revision,r.version_id,r.configuration FROM agents_platform.automations a JOIN agents_platform.automation_revisions r ON r.automation_id=a.id AND r.revision=a.revision JOIN agents_platform.agent_versions v ON v.id=r.version_id JOIN agents_platform.agents g ON g.id=v.agent_id AND g.organization_id=v.organization_id WHERE a.state='active' AND g.deleted_at IS NULL ORDER BY a.id${lock ? " FOR UPDATE OF a" : ""}`)).rows;
  targets.push(...automations.map(row => ({ kind: "automation" as const, id: row.id, versionId: row.version_id, revision: row.revision, configuration: row.configuration })));
  const needed = new Set<string>();
  function include(id: string, path = new Set<string>()) {
    if (path.has(id))
      throw new PlatformError("RUNTIME_ROLLOUT_CYCLE", 409, "Published specialist references contain a cycle.");
    if (needed.has(id))
      return;
    const version = byId.get(id);
    if (!version)
      throw new PlatformError("RUNTIME_ROLLOUT_VERSION_UNAVAILABLE", 409, "An active publication references an unavailable agent.");
    const configuration = agentConfigurationSchema.parse(version.configuration), next = new Set([...path, id]);
    if (configuration.capabilities.delegation.enabled)
      for (const role of configuration.capabilities.delegation.bindings)
        include(role.versionId, next);
    needed.add(id);
  }
  for (const target of targets)
    include(target.versionId);
  const changes: Change[] = [], mapped = new Map<string, Change>();
  const definitionVersions = new Map(targets.filter(target => target.kind === "definition").map(target => [target.id, target.versionId]));
  const nextNumber = new Map(agents.map(agent => [agent.id, Math.max(0, ...versions.filter(version => version.agent_id === agent.id).map(version => version.number))]));
  const nextDraft = new Map(agents.map(agent => [agent.id, Math.max(agent.draft_revision, ...versions.filter(version => version.agent_id === agent.id).map(version => version.draft_revision))]));
  const pending = new Set(needed);
  while (pending.size) {
    let progressed = false;
    for (const version of versions) {
      if (!pending.has(version.id))
        continue;
      const earlier = versions.some(candidate => candidate.agent_id === version.agent_id && candidate.number < version.number && pending.has(candidate.id));
      const configuration = agentConfigurationSchema.parse(version.configuration);
      const roles = configuration.capabilities.delegation.enabled ? configuration.capabilities.delegation.bindings : [];
      if (earlier || roles.some(role => pending.has(role.versionId)))
        continue;
      for (const role of roles) {
        const child = mapped.get(role.versionId);
        if (child) {
          role.versionId = child.id;
          if (role.versionNumber !== undefined)
            role.versionNumber = child.number;
        }
      }
      const selected = (await db.query("SELECT b.binding FROM agents_platform.version_connected_tools v JOIN agents_platform.capability_bindings b ON b.organization_id=v.organization_id AND b.id=v.binding_id WHERE v.organization_id=$1 AND v.version_id=$2 AND b.id=ANY($3::uuid[]) ORDER BY b.alias", [version.organization_id, version.id, configuration.connectedToolBindingIds])).rows.map(row => capabilityBindingSchema.parse(row.binding));
      if (selected.length !== configuration.connectedToolBindingIds.length)
        throw new PlatformError("RUNTIME_ROLLOUT_BINDINGS_UNAVAILABLE", 409, "Published connected-tool references are unavailable.");
      const toolBindings = publishedToolBindings(configuration), composition = compilePublishedComposition(configuration, selected as CapabilityBinding[]);
      // New snapshots of older pinned versions must not supersede the current definition.
      const preserveLatest = definitionVersions.get(version.agent_id) === version.id
        && changes.some(change => change.previous.agent_id === version.agent_id);
      if (preserveLatest || !equal(configuration, version.configuration) || !equal(toolBindings, version.tool_bindings) || !equal(composition, version.effective_composition)) {
        const number = nextNumber.get(version.agent_id)! + 1, draftRevision = nextDraft.get(version.agent_id)! + 1;
        nextNumber.set(version.agent_id, number);
        nextDraft.set(version.agent_id, draftRevision);
        const change = { previous: version, id: stableId({ revision: runtimeRolloutRevision, previous: version.id, configuration, toolBindings, composition }), number, draftRevision, configuration, toolBindings, composition };
        changes.push(change);
        mapped.set(version.id, change);
      }
      pending.delete(version.id);
      progressed = true;
    }
    if (!progressed)
      throw new PlatformError("RUNTIME_ROLLOUT_CYCLE", 409, "Published specialist ordering cannot be preserved.");
  }
  const affected = changes.map(change => change.previous.id);
  const busyTasks = (await db.query("SELECT id FROM agents_platform.tasks WHERE version_id=ANY($1::uuid[]) AND state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') ORDER BY id", [affected])).rows.map(row => row.id as string);
  const excluded = (await db.query(`SELECT
  (SELECT count(*)::int FROM agents_platform.website_deployments WHERE revoked_at IS NOT NULL OR paused) AS inactive_websites,
  (SELECT count(*)::int FROM agents_platform.channel_deployments WHERE state<>'active') AS inactive_channels,
  (SELECT count(*)::int FROM agents_platform.product_execution_features WHERE NOT enabled) AS disabled_features,
  (SELECT count(*)::int FROM agents_platform.automations WHERE state<>'active') AS inactive_automations,
  (SELECT count(*)::int FROM agents_platform.evaluation_trial_channels) AS evaluation_websites`)).rows[0] as Record<string, number>;
  const digest = requestDigest({ revision: runtimeRolloutRevision, currentRuntime, agents: agents.map(agent => [agent.id, agent.draft_revision, requestDigest(agent.draft)]), targets, changes: changes.map(change => [change.previous.id, change.id, change.number, change.draftRevision, change.composition.digest]) });
  return { agents, targets, changes, digest, busyTasks, excluded };
}
function preview(value: Plan): RuntimeRolloutPreview {
  const mapped = new Map(value.changes.map(change => [change.previous.id, change.id]));
  return { revision: runtimeRolloutRevision, runtime: currentRuntime, digest: value.digest,
    versions: value.changes.map(change => ({ agentId: change.previous.agent_id, previousVersionId: change.previous.id, versionId: change.id, number: change.number })),
    targets: value.targets.map(target => ({ kind: target.kind, id: target.id, ...(target.product ? {product: target.product, tenantId: target.tenantId} : {}), previousVersionId: target.versionId, versionId: mapped.get(target.versionId) ?? target.versionId })), busyTaskIds: value.busyTasks, excluded: value.excluded };
}
export async function previewRuntimeRollout(pool: Pool): Promise<RuntimeRolloutPreview> { return transaction(pool, async (db) => preview(await plan(db, true))); }
export async function applyRuntimeRollout(pool: Pool, expectedDigest: string): Promise<RuntimeRolloutPreview & {
  applied: boolean;
}> {
  return transaction(pool, async (db) => {
    const value = await plan(db, true), report = preview(value);
    if (!value.changes.length)
      return { ...report, applied: false };
    if (value.digest !== expectedDigest)
      changed();
    if (value.busyTasks.length)
      throw new PlatformError("RUNTIME_ROLLOUT_DRAIN_REQUIRED", 409, "Wait for accepted agent work to finish before applying the runtime rollout.");
    const mapped = new Map(value.changes.map(change => [change.previous.id, change]));
    for (const change of value.changes) {
      const old = change.previous;
      await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by,created_by_service,tool_bindings,effective_composition)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [change.id, old.organization_id, old.agent_id, change.number, change.draftRevision, old.execution_kind, change.configuration, old.created_by, old.created_by_service, JSON.stringify(change.toolBindings), change.composition]);
      await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1", [old.id, change.id]);
      await db.query("INSERT INTO agents_platform.version_connected_tools(organization_id,version_id,binding_id) SELECT organization_id,$2,binding_id FROM agents_platform.version_connected_tools WHERE version_id=$1", [old.id, change.id]);
    }
    for (const agent of value.agents) {
      const changes = value.changes.filter(change => change.previous.agent_id === agent.id);
      if (!changes.length)
        continue;
      const last = changes.at(-1)!, latest = value.targets.find(target => target.kind === "definition" && target.id === agent.id);
      const latestChange = latest ? mapped.get(latest.versionId) : undefined;
      const pristine = latestChange && equal(agent.draft, latestChange.previous.configuration);
      const draftRevision = pristine ? last.draftRevision : last.draftRevision + 1;
      const result = await db.query("UPDATE agents_platform.agents SET draft_revision=$2,draft=$4,updated_at=now() WHERE id=$1 AND draft_revision=$3", [agent.id, draftRevision, agent.draft_revision, pristine ? latestChange.configuration : agent.draft]);
      if (!result.rowCount)
        changed();
    }
    for (const target of value.targets) {
      const change = mapped.get(target.versionId);
      if (!change || target.kind === "definition")
        continue;
      let result;
      if (target.kind === "website")
        result = await db.query("UPDATE agents_platform.website_deployments SET version_id=$3 WHERE id=$1 AND version_id=$2 AND revoked_at IS NULL AND NOT paused", [target.id, target.versionId, change.id]);
      else if (target.kind === "channel")
        result = await db.query("UPDATE agents_platform.channel_deployments SET version_id=$3,revision=revision+1,updated_at=now() WHERE id=$1 AND version_id=$2 AND revision=$4 AND state='active'", [target.id, target.versionId, change.id, target.revision]);
      else if (target.kind === "product")
        result = await db.query("UPDATE agents_platform.product_execution_features SET version_id=$4,revision=greatest(revision+1,$7),managed_configuration_digest=$8,managed_capability_baseline=$9,updated_at=now() WHERE product=$1 AND tenant_id=$2 AND feature_id=$3 AND version_id=$5 AND revision=$6 AND enabled", [target.product, target.tenantId, target.id, change.id, target.versionId, target.revision, Math.max(...value.changes.filter(item => item.previous.agent_id === change.previous.agent_id).flatMap(item => [item.number, item.draftRevision + 1])), target.managedDigest === requestDigest(change.previous.configuration) ? requestDigest(change.configuration) : target.managedDigest ?? null, remapBaseline(target.managedBaseline, mapped)]);
      else {
        const revision = target.revision! + 1, configuration = { ...target.configuration, versionId: change.id };
        await db.query("INSERT INTO agents_platform.automation_revisions(automation_id,revision,version_id,configuration) VALUES($1,$2,$3,$4)", [target.id, revision, change.id, configuration]);
        await db.query("INSERT INTO agents_platform.automation_model_routes(automation_id,revision,organization_id,version_id,routes,snapshot_digest) SELECT automation_id,$3,organization_id,$4,routes,snapshot_digest FROM agents_platform.automation_model_routes WHERE automation_id=$1 AND revision=$2", [target.id, target.revision, revision, change.id]);
        result = await db.query("UPDATE agents_platform.automations SET revision=$3,updated_at=now() WHERE id=$1 AND revision=$2 AND state='active'", [target.id, target.revision, revision]);
        await db.query("INSERT INTO agents_platform.automation_timer_outbox(automation_id,revision) VALUES($1,$2)", [target.id, revision]);
      }
      if (!result.rowCount)
        changed();
    }
    return { ...report, applied: true };
  });
}
