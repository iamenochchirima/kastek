import type { Pool } from "pg";
import { agentConfigurationSchema, PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { executionModelLayers, modelServicePolicy } from "../../execution/models/settings";
import { loadBookingPolicy } from "../../workflows/booking/policy";
import { AgentStore } from "./agent-store";

type Requirement = { state: "ready" | "needs_setup" | "deferred"; code: string | null };
const ready = (): Requirement => ({ state: "ready", code: null });
const missing = (code: string): Requirement => ({ state: "needs_setup", code });
const deferred = (): Requirement => ({ state: "deferred", code: null });

/** Saved metadata checks only. This does not infer, discover providers or prove provider acceptance. */
export async function customerSetupReadiness(pool: Pool, accountId: string, organizationId: string, agentId: string) {
  const agent = await new AgentStore(pool).getAgent(accountId, organizationId, agentId);
  const configuration = agentConfigurationSchema.parse(agent.draft);
  return transaction(pool, async db => {
    if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE", [organizationId, accountId])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
    const requirements: Record<string, Requirement> = {};
    const check = async (run: () => Promise<unknown>): Promise<Requirement> => {
      // Policy checks use SAVEPOINT because a rejected metadata read must not poison the transaction.
      await db.query("SAVEPOINT readiness_requirement");
      try { await run(); await db.query("RELEASE SAVEPOINT readiness_requirement"); return ready(); }
      catch (error) { await db.query("ROLLBACK TO SAVEPOINT readiness_requirement"); await db.query("RELEASE SAVEPOINT readiness_requirement"); if (!(error instanceof PlatformError)) throw error; return missing(error.code); }
    };
    requirements.model = await check(async () => {
      const routes = await resolveAcceptedModelRoutes(db, { organizationId, agentId, product: "agents", selection: configuration.model.selection, generation: configuration.model.generation,
        layers: executionModelLayers(configuration, { id: `setup:${agentId}`, maxInputBytes: configuration.model.maxInputBytes, maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: configuration.context.maxInputTokens, rootTokenLimit: modelServicePolicy().maxRootTokens }),
        requiresTools: configuration.tools.length > 0 || configuration.connectedToolBindingIds.length > 0 || configuration.skillIds.length > 0 });
      const credential = await db.query("SELECT 1 FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2 AND revision=$3 AND state='active'", [organizationId, routes.primary.binding.connectionId, routes.primary.binding.credentialRevision]);
      if (!credential.rowCount) throw new PlatformError("MODEL_CREDENTIAL_UNAVAILABLE", 409, "Reconnect the model provider");
    });
    const sources = (await db.query(`SELECT r.id,s.state,s.visibility,p.state AS policy_state FROM agents_platform.source_revisions r
      JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id
      JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.organization_id=r.organization_id
      WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[])`, [organizationId, configuration.sourceRevisionIds])).rows;
    const approved = sources.length === configuration.sourceRevisionIds.length && sources.every(s => s.state === "active" && s.policy_state === "approved");
    requirements.knowledge = !configuration.sourceRevisionIds.length ? deferred() : approved ? ready() : missing("KNOWLEDGE_NOT_APPROVED");
    requirements.customerKnowledge = !configuration.sourceRevisionIds.length ? deferred() : approved && sources.every(s => s.visibility === "public") ? ready() : missing("KNOWLEDGE_NOT_PUBLIC");
    const responsibilities = agent.setup?.responsibilities ?? [];
    requirements.bookings = responsibilities.includes("bookings") ? configuration.capabilities.businessActions.enabled
      ? await check(() => loadBookingPolicy(db, organizationId, agentId, configuration.capabilities.businessActions as Parameters<typeof loadBookingPolicy>[3])) : missing("BOOKING_POLICY_REQUIRED") : deferred();
    requirements.enquiries = responsibilities.includes("enquiries") ? configuration.capabilities.enquiries?.enabled && configuration.tools.includes("enquiry.submit") ? ready() : missing("ENQUIRY_CAPABILITY_REQUIRED") : deferred();
    requirements.handoff = configuration.tools.includes("channel.request_handoff") ? ready() : deferred();
    const websites = (await db.query("SELECT id,paused FROM agents_platform.website_deployments WHERE organization_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.deployment_id=website_deployments.id)", [organizationId, agentId])).rows;
    const messaging = (await db.query(`SELECT d.id,d.state,c.kind,c.state AS connection_state FROM agents_platform.channel_deployments d
      JOIN agents_platform.channel_connections c ON c.id=d.connection_id AND c.organization_id=d.organization_id
      WHERE d.organization_id=$1 AND d.agent_id=$2 AND d.state<>'revoked'`, [organizationId, agentId])).rows;
    const channels = (agent.setup?.channels ?? []).map(kind => {
      const rows = kind === "website" ? websites.map(row => ({ id: row.id, paused: row.paused, active: true })) : messaging.filter(row => row.kind === kind).map(row => ({ id: row.id, paused: row.state === "paused", active: row.connection_state === "active" }));
      return { kind, state: rows.some(row => row.active && !row.paused) ? "connected" : rows.some(row => !row.active) ? "needs_attention" : rows.length ? "paused" : "needs_connection" };
    });
    return { agentId, draftRevision: agent.draft_revision, setupStep: agent.setup_step ?? null, requirements, channels, readyToTest: requirements.model.state === "ready" };
  });
}
