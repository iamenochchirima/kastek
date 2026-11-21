import type { Pool } from "pg";
import { PlatformError, type AgentConfiguration } from "../../contracts/contracts";
import type { ApplicationAgentBinding, ApplicationAgentPreviewResponse, ApplicationAgentVersionSummary } from "@kasitek-labs/contracts";
import { configurationCapabilityError } from "../../platform/capabilities";
import type { PlatformStore } from "./store";
import type { agentCreationOperations } from "./creation-operations";

type Caller = { organizationId: string; applicationId: string; credentialId: string };
type Agent = { id: string; name: string; draft_revision: number };

/** Agent management for registered applications, acting through the application creator's workspace account. */
export function createApplicationAgentManagement(options: {
  pool: Pool;
  store: PlatformStore;
  operations: ReturnType<typeof agentCreationOperations>;
  assertBindings(configuration: AgentConfiguration): Promise<void>;
}) {
  async function creator(caller: Caller): Promise<string> {
    const row = (await options.pool.query<{ created_by: string }>("SELECT created_by FROM agents_platform.applications WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL",
      [caller.organizationId, caller.applicationId])).rows[0];
    if (!row) throw new PlatformError("ACCESS_DENIED", 403, "Application access is unavailable");
    return row.created_by;
  }
  async function assigned(caller: Caller, agentId: string): Promise<string> {
    const accountId = await creator(caller);
    const row = (await options.pool.query("SELECT 1 FROM agents_platform.applications WHERE organization_id=$1 AND id=$2 AND $3=ANY(agent_ids)",
      [caller.organizationId, caller.applicationId, agentId])).rows[0];
    if (!row) throw new PlatformError("NOT_FOUND", 404, "Agent not found");
    return accountId;
  }
  async function configurationError(configuration: AgentConfiguration): Promise<string | null> {
    try { await options.assertBindings(configuration); } catch (error) {
      if (error instanceof PlatformError) return error.message;
      throw error;
    }
    return configurationCapabilityError(configuration);
  }

  return {
    async create(caller: Caller, input: { name: string; purpose?: string; instructions?: string; operationId: string }) {
      const accountId = await creator(caller);
      const created = await options.operations.create({ accountId, organizationId: caller.organizationId }, input);
      await options.pool.query(`UPDATE agents_platform.applications SET agent_ids=agent_ids||ARRAY[$3::uuid]
        WHERE organization_id=$1 AND id=$2 AND NOT agent_ids @> ARRAY[$3]::uuid[]`, [caller.organizationId, caller.applicationId, created.agent.id]);
      return { id: created.agent.id, name: created.agent.name, draftRevision: created.agent.draft_revision };
    },
    async update(caller: Caller, agentId: string, input: { name?: string; configuration: AgentConfiguration; expectedRevision: number }) {
      const accountId = await assigned(caller, agentId);
      const error = await configurationError(input.configuration);
      if (error) throw new PlatformError("CONFIGURATION_INVALID", 400, error);
      const agent = await options.store.updateDraft({ ...input, accountId, organizationId: caller.organizationId, agentId });
      return { id: agent.id, name: agent.name, draftRevision: agent.draft_revision };
    },
    async preview(caller: Caller, agentId: string, input: { configuration: AgentConfiguration }): Promise<ApplicationAgentPreviewResponse> {
      await assigned(caller, agentId);
      const errors: Array<{ code: string; message: string }> = [];
      try { await options.assertBindings(input.configuration); } catch (error) {
        if (error instanceof PlatformError) errors.push({ code: error.code, message: error.message }); else throw error;
      }
      const capability = configurationCapabilityError(input.configuration);
      if (capability) errors.push({ code: capability.split(":")[0]!, message: "Enable tools before workflows" });
      return { ready: errors.length === 0, errors };
    },
    async publish(caller: Caller, agentId: string, input: { expectedRevision: number }): Promise<ApplicationAgentVersionSummary> {
      const accountId = await assigned(caller, agentId);
      const agent = await options.store.getAgent(accountId, caller.organizationId, agentId);
      await options.assertBindings(agent.draft as AgentConfiguration);
      const version = await options.store.createVersion({ ...input, accountId, organizationId: caller.organizationId, agentId });
      return { id: version.id, number: version.number, createdAt: version.created_at.toISOString() };
    },
    async bind(caller: Caller, agentId: string, input: { versionId?: string; allowedOrigins: string[] }): Promise<ApplicationAgentBinding> {
      const accountId = await assigned(caller, agentId);
      const publication = { accountId, organizationId: caller.organizationId, agentId, allowedOrigins: input.allowedOrigins };
      const deployment = input.versionId ? await options.store.publishWebsite({ ...publication, versionId: input.versionId })
        : await options.store.publishCurrentWebsite(publication);
      return { id: deployment.id, versionId: deployment.version_id, allowedOrigins: deployment.allowed_origins,
        publishedAt: deployment.published_at.toISOString() };
    },
  };
}
