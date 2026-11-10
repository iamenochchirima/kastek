import { recordAssistantLifecycle } from "../reporting/assistant-lifecycle";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { defaultBusinessConfiguration, PlatformError } from "../../contracts/contracts";
import type { AgentRecord, VersionRecord } from "../../contracts/records";
import { AuthorityStore } from "../../execution/admission/authority-store";
import { randomAgentAvatar } from "./avatars";

export type OrganizationAssistant = {
  state: "absent" | "draft" | "configured" | "deleted";
  agentId: string | null;
  agent: AgentRecord | null;
  version: VersionRecord | null;
};

async function readAssistant(db: PoolClient, organizationId: string): Promise<OrganizationAssistant> {
  const marker = (await db.query<{ agent_id: string }>(
    "SELECT agent_id FROM agents_platform.organization_assistants WHERE organization_id=$1", [organizationId],
  )).rows[0];
  if (!marker) return { state: "absent", agentId: null, agent: null, version: null };
  const agent = (await db.query<AgentRecord>(
    "SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL", [organizationId, marker.agent_id],
  )).rows[0];
  if (!agent) return { state: "deleted", agentId: marker.agent_id, agent: null, version: null };
  const version = (await db.query<VersionRecord>(
    "SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1", [organizationId, agent.id],
  )).rows[0] ?? null;
  return { state: version ? "configured" : "draft", agentId: agent.id, agent, version };
}

/** The marker records lifecycle ownership only. Admission uses ordinary membership and grants. */
export async function ensureOrganizationAssistantInTransaction(
  db: PoolClient, input: { accountId: string; organizationId: string },
): Promise<OrganizationAssistant> {
  const organization = await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.organizationId]);
  if (!organization.rowCount) throw new PlatformError("NOT_FOUND", 404, "Organization not found");
  const manager = await db.query(`SELECT account_id FROM agents_platform.memberships
    WHERE organization_id=$1 AND account_id=$2 AND role IN ('owner','admin') AND revoked_at IS NULL FOR SHARE`, [input.organizationId, input.accountId]);
  if (!manager.rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Owner or admin access required");
  const current = await readAssistant(db, input.organizationId);
  if (current.state !== "absent") return current;
  const configuration = defaultBusinessConfiguration();
  configuration.program = { id: "tool-directed", version: "2" };
  configuration.tools = ["tasks.inspect", "tasks.cancel"];
  configuration.instructions = "Help the signed-in organization member with their request. Use only configured knowledge, tools and specialists. Ask for missing details when needed. Report actions and results only when confirmed. Return private drafts to the requesting member.";
  const agentId = randomUUID();
  await db.query(`INSERT INTO agents_platform.agents(id,organization_id,name,avatar,draft,created_by)
    VALUES($1,$2,'Assistant',$3,$4,$5)`, [agentId, input.organizationId, randomAgentAvatar(), configuration, input.accountId]);
  await db.query("INSERT INTO agents_platform.organization_assistants(organization_id,agent_id) VALUES($1,$2)", [input.organizationId, agentId]);
  await recordAssistantLifecycle(db,{organizationId:input.organizationId,key:agentId,action:"provisioned",channel:"app"});
  return readAssistant(db, input.organizationId);
}

export class OrganizationAssistantStore extends AuthorityStore {
  async getOrganizationAssistant(accountId: string, organizationId: string): Promise<OrganizationAssistant> {
    return this.transaction(async db => {
      await this.membership(db, accountId, organizationId);
      return readAssistant(db, organizationId);
    });
  }

  async repairOrganizationAssistant(accountId: string, organizationId: string): Promise<OrganizationAssistant> {
    return this.transaction(async db => {
      const assistant = await ensureOrganizationAssistantInTransaction(db, { accountId, organizationId });
      if (assistant.state !== "deleted") return assistant;
      // Restore configuration only. Deleted deployments, automations and grants remain revoked.
      await db.query("UPDATE agents_platform.agents SET deleted_at=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2", [organizationId, assistant.agentId]);
      await recordAssistantLifecycle(db,{organizationId,key:`restore:${assistant.agentId}:${Date.now()}`,action:"restored",channel:"app"});
      return readAssistant(db, organizationId);
    });
  }
}
