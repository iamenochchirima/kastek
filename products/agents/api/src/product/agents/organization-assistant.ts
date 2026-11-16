import { recordAssistantLifecycle } from "../reporting/assistant-lifecycle";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { defaultBusinessConfiguration, PlatformError, type AgentConfiguration } from "../../contracts/contracts";
import type { AgentRecord, VersionRecord } from "../../contracts/records";
import { AuthorityStore } from "../../execution/admission/authority-store";
import { AgentStore } from "./agent-store";
import { randomAgentAvatar } from "./avatars";

export type OrganizationAssistant = {
  state: "absent" | "draft" | "configured" | "deleted";
  agentId: string | null;
  agent: AgentRecord | null;
  version: VersionRecord | null;
  modelReady: boolean;
};

async function modelReady(db: PoolClient, organizationId: string, configuration: AgentConfiguration): Promise<boolean> {
  const selection = configuration.model.selection;
  if (selection.kind === "organization_default") {
    return Boolean((await db.query(`SELECT 1 FROM agents_platform.model_provider_defaults d
      JOIN agents_platform.model_provider_connections c ON c.id=d.connection_id AND c.organization_id=d.organization_id
      WHERE d.organization_id=$1 AND c.state='active' LIMIT 1`, [organizationId])).rowCount);
  }
  return Boolean((await db.query(`SELECT 1 FROM agents_platform.model_provider_connections
    WHERE organization_id=$1 AND id=$2 AND state='active'`, [organizationId, selection.connectionId])).rowCount);
}

async function readAssistant(db: PoolClient, organizationId: string): Promise<OrganizationAssistant> {
  const marker = (await db.query<{ agent_id: string }>(
    "SELECT agent_id FROM agents_platform.organization_assistants WHERE organization_id=$1", [organizationId],
  )).rows[0];
  if (!marker) return { state: "absent", agentId: null, agent: null, version: null, modelReady: false };
  const agent = (await db.query<AgentRecord>(
    "SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL", [organizationId, marker.agent_id],
  )).rows[0];
  if (!agent) return { state: "deleted", agentId: marker.agent_id, agent: null, version: null, modelReady: false };
  const version = (await db.query<VersionRecord>(
    "SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1", [organizationId, agent.id],
  )).rows[0] ?? null;
  return { state: version ? "configured" : "draft", agentId: agent.id, agent, version,
    modelReady: version ? await modelReady(db, organizationId, version.configuration) : false };
}

/** Create the first immutable version for an assistant that was provisioned before default versions existed. */
async function ensureDefaultVersion(db: PoolClient, pool: Pool, assistant: OrganizationAssistant, accountId: string): Promise<OrganizationAssistant> {
  if (assistant.state !== "draft" || !assistant.agent) return assistant;
  const agent = assistant.agent;
  await new AgentStore(pool).createVersionInTransaction(db, { accountId, organizationId: agent.organization_id, agentId: agent.id }, agent);
  return readAssistant(db, agent.organization_id);
}

/** A draft that cannot publish stays a draft for the owner; reading it must not fail the whole panel. */
async function repairDefaultVersion(db: PoolClient, pool: Pool, assistant: OrganizationAssistant, accountId: string): Promise<OrganizationAssistant> {
  if (assistant.state !== "draft" || !assistant.agent) return assistant;
  await db.query("SAVEPOINT repair_default_version");
  try {
    const repaired = await ensureDefaultVersion(db, pool, assistant, accountId);
    await db.query("RELEASE SAVEPOINT repair_default_version");
    return repaired;
  } catch (error) {
    await db.query("ROLLBACK TO SAVEPOINT repair_default_version");
    if (error instanceof PlatformError && error.statusCode < 500) return assistant;
    throw error;
  }
}

/** The marker records lifecycle ownership only. Admission uses ordinary membership and grants. */
export async function ensureOrganizationAssistantInTransaction(
  db: PoolClient, input: { accountId: string; organizationId: string; pool: Pool },
): Promise<OrganizationAssistant> {
  const organization = await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.organizationId]);
  if (!organization.rowCount) throw new PlatformError("NOT_FOUND", 404, "Organization not found");
  const manager = await db.query(`SELECT account_id FROM agents_platform.memberships
    WHERE organization_id=$1 AND account_id=$2 AND role IN ('owner','admin') AND revoked_at IS NULL FOR SHARE`, [input.organizationId, input.accountId]);
  if (!manager.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Owner or admin access required");
  const current = await readAssistant(db, input.organizationId);
  if (current.state !== "absent") return ensureDefaultVersion(db, input.pool, current, input.accountId);
  const configuration = defaultBusinessConfiguration();
  configuration.program = { id: "tool-directed", version: "2" };
  configuration.tools = ["tasks.inspect", "tasks.cancel"];
  configuration.instructions = "Help the signed-in organization member with their request. Use only configured knowledge, tools and specialists. Ask for missing details when needed. Report actions and results only when confirmed. Return private drafts to the requesting member.";
  const agentId = randomUUID();
  const agent = (await db.query<AgentRecord>(`INSERT INTO agents_platform.agents(id,organization_id,name,avatar,draft,created_by)
    VALUES($1,$2,'Assistant',$3,$4,$5) RETURNING *`, [agentId, input.organizationId, randomAgentAvatar(), configuration, input.accountId])).rows[0]!;
  await new AgentStore(input.pool).createVersionInTransaction(db, { accountId: input.accountId, organizationId: input.organizationId, agentId }, agent);
  await db.query("INSERT INTO agents_platform.organization_assistants(organization_id,agent_id) VALUES($1,$2)", [input.organizationId, agentId]);
  await recordAssistantLifecycle(db,{organizationId:input.organizationId,key:agentId,action:"provisioned",channel:"app"});
  return readAssistant(db, input.organizationId);
}

export class OrganizationAssistantStore extends AuthorityStore {
  async getOrganizationAssistant(accountId: string, organizationId: string): Promise<OrganizationAssistant> {
    return this.transaction(async db => {
      await this.membership(db, accountId, organizationId);
      let assistant = await readAssistant(db, organizationId);
      if (assistant.state !== "draft" || !assistant.agent) return assistant;
      // Legacy draft: serialize the one-time repair, then create the default version.
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [organizationId]);
      assistant = await readAssistant(db, organizationId);
      return repairDefaultVersion(db, this.pool, assistant, accountId);
    });
  }

  async repairOrganizationAssistant(accountId: string, organizationId: string): Promise<OrganizationAssistant> {
    return this.transaction(async db => {
      let assistant = await ensureOrganizationAssistantInTransaction(db, { accountId, organizationId, pool: this.pool });
      if (assistant.state === "deleted") {
        // Restore configuration only. Deleted deployments, automations and grants remain revoked.
        await db.query("UPDATE agents_platform.agents SET deleted_at=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2", [organizationId, assistant.agentId]);
        assistant = await readAssistant(db, organizationId);
        await recordAssistantLifecycle(db,{organizationId,key:`restore:${assistant.agentId}:${Date.now()}`,action:"restored",channel:"app"});
      }
      return ensureDefaultVersion(db, this.pool, assistant, accountId);
    });
  }
}
