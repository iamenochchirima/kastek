import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { agentConfigurationSchema, type AgentConfiguration } from "../../contracts/contracts";
import { afterHoursAssistance } from "../../contracts/procedure-definitions";
import type { Account, AgentRecord, VersionRecord, WebsiteDeployment } from "../../contracts/records";
import { pageQuery } from "../../infrastructure/read-pages";
import { requirePermission } from "../access";

export type AgentScope = { account: Account; organizationId: string };
type Scope = { accountId: string; organizationId: string };

/** Agent records and publication, as used by the management routes. */
export interface AgentManagementStorePort {
  requireMembership(accountId: string, organizationId: string): Promise<void>;
  getAgent(accountId: string, organizationId: string, agentId: string): Promise<AgentRecord>;
  identityDefaults(accountId: string, organizationId: string, agentId: string): Promise<unknown>;
  deleteAgent(accountId: string, organizationId: string, agentId: string): Promise<void>;
  updateDraft(input: { accountId: string; organizationId: string; agentId: string; name?: string; avatar?: string;
    configuration: AgentConfiguration; expectedRevision: number }): Promise<AgentRecord>;
  createVersion(input: { accountId: string; organizationId: string; agentId: string; expectedRevision: number }): Promise<VersionRecord>;
  listVersions(accountId: string, organizationId: string, agentId: string): Promise<VersionRecord[]>;
  listDeployments(accountId: string, organizationId: string, agentId: string): Promise<WebsiteDeployment[]>;
  publishWebsite(input: { accountId: string; organizationId: string; agentId: string; versionId: string;
    allowedOrigins: string[] }): Promise<WebsiteDeployment>;
  publishCurrentWebsite(input: { accountId: string; organizationId: string; agentId: string;
    allowedOrigins: string[] }): Promise<WebsiteDeployment>;
}

/** Creation, configuration and readiness operations shared with the MCP interface. */
export interface AgentOperationsPort {
  list(scope: Scope): Promise<AgentRecord[]>;
  create(scope: Scope, raw: unknown): Promise<{ agent: AgentRecord; snapshot: VersionRecord }>;
  get(scope: Scope, agentId: string): Promise<AgentRecord>;
  readiness(scope: Scope, agentId: string): Promise<unknown>;
  profile(scope: Scope, agentId: string, raw: unknown): Promise<AgentRecord>;
  setCapabilities(scope: Scope, agentId: string, raw: unknown): Promise<{ agent: AgentRecord; snapshot: VersionRecord }>;
  save(scope: Scope, agentId: string, raw: unknown): Promise<{ agent: AgentRecord; snapshot: VersionRecord; deployments: WebsiteDeployment[] }>;
}

type SummaryQuery = z.infer<ReturnType<typeof summaryQuery>>;
function summaryQuery() {
  return pageQuery.extend({ q: z.string().trim().max(120).optional(),
    status: z.enum(["all", "configured", "changes-pending", "setup"]).optional() }).strict();
}
const summary = ({ position: _position, ...row }: Record<string, unknown>) => row;

/**
 * Management routes for the standalone Agents workspace. Paths stay unchanged while the handlers
 * move out of composition. Data access and product-owned defaults arrive as ports.
 */
export function registerAgentManagementRoutes(app: FastifyInstance, options: {
  pool: Pool;
  store: AgentManagementStorePort;
  operations: AgentOperationsPort;
  summaries(scope: AgentScope, query: SummaryQuery): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }>;
  specialists(scope: AgentScope, agentId: string): Promise<unknown>;
  offerings: readonly unknown[];
  avatarSchema: z.ZodType<string>;
  assertBindings(configuration: AgentConfiguration): Promise<void>;
  composedInstructions(configuration: Pick<AgentConfiguration, "instructions" | "identity" | "guidance">): string;
  present(record: object): object;
  resolveScope(request: FastifyRequest): Promise<AgentScope>;
}) {
  const base = "/api/organizations/:organizationId";
  const uuid = z.uuid();
  const parameters = (request: FastifyRequest) => request.params as Record<string, string>;
  const agentId = (request: FastifyRequest) => uuid.parse(parameters(request).agentId);
  const scope = async (request: FastifyRequest) => {
    const value = await options.resolveScope(request);
    return { accountId: value.account.id, organizationId: value.organizationId, value };
  };

  app.get(`${base}/agents/summaries`, async request => {
    const resolved = await scope(request), query = summaryQuery().parse(request.query);
    const page = await options.summaries(resolved.value, query);
    return { agents: page.items.map(row => summary(row as Record<string, unknown>)), nextCursor: page.nextCursor };
  });

  app.get(`${base}/agents/:agentId/specialists`, async request => {
    return options.specialists(await options.resolveScope(request), agentId(request));
  });

  app.get(`${base}/agents`, async request => {
    const resolved = await scope(request);
    return { agents: (await options.operations.list(resolved)).map(options.present) };
  });

  app.post(`${base}/agents`, async (request, reply) => {
    const resolved = await scope(request);
    const created = await options.operations.create(resolved, request.body);
    return reply.code(201).send({ agent: options.present(created.agent), snapshot: options.present(created.snapshot) });
  });

  app.get(`${base}/agents/:agentId`, async request => {
    const resolved = await scope(request), id = agentId(request);
    const agent = await options.operations.get(resolved, id);
    const [versions, deployments] = await Promise.all([
      options.store.listVersions(resolved.accountId, resolved.organizationId, id),
      options.store.listDeployments(resolved.accountId, resolved.organizationId, id),
    ]);
    return { agent: options.present(agent), versions: versions.map(options.present), deployments: deployments.map(options.present) };
  });

  app.post(`${base}/agents/:agentId/effective-settings`, async request => {
    const resolved = await scope(request);
    await options.store.requireMembership(resolved.accountId, resolved.organizationId);
    uuid.parse(parameters(request).agentId);
    const { configuration } = z.strictObject({ configuration: agentConfigurationSchema }).parse(request.body);
    return { composed: options.composedInstructions(configuration), sources: configuration.sourceRevisionIds.length,
      tools: configuration.tools.length, connectedTools: configuration.connectedToolBindingIds.length, skills: configuration.skillIds.length };
  });

  app.get(`${base}/agents/:agentId/identity-defaults`, async request => {
    const resolved = await scope(request);
    return { defaults: await options.store.identityDefaults(resolved.accountId, resolved.organizationId, agentId(request)) };
  });

  app.get(`${base}/agents/:agentId/procedures`, async request => {
    const resolved = await scope(request);
    const agent = await options.store.getAgent(resolved.accountId, resolved.organizationId, agentId(request));
    const config = agentConfigurationSchema.parse(agent.draft);
    const reasons = [
      ...(!config.tools.includes("channel.request_handoff") ? [{ code: "HUMAN_SUPPORT_DISABLED", message: "Enable human support" }] : []),
      ...(!config.tools.includes("support.get_status_v2") ? [{ code: "SUPPORT_STATUS_DISABLED", message: "Enable support status" }] : []),
      ...(!config.supportHours ? [{ code: "SUPPORT_HOURS_MISSING", message: "Set support hours" }] : []),
    ];
    return { entries: [{ id: afterHoursAssistance.id, version: afterHoursAssistance.version, name: afterHoursAssistance.title,
      description: afterHoursAssistance.description,
      readiness: { state: reasons.length ? "unavailable" : "ready", reasons } }] };
  });

  app.delete(`${base}/agents/:agentId`, async (request, reply) => {
    const resolved = await scope(request);
    await requirePermission(options.pool, { accountId: resolved.accountId, organizationId: resolved.organizationId }, "agents.delete");
    await options.store.deleteAgent(resolved.accountId, resolved.organizationId, agentId(request));
    return reply.code(204).send();
  });

  app.get(`${base}/agents/:agentId/setup-readiness`, async request => {
    const resolved = await scope(request);
    return { readiness: await options.operations.readiness(resolved, agentId(request)) };
  });

  app.put(`${base}/agents/:agentId`, async request => {
    const resolved = await scope(request);
    await requirePermission(options.pool, { accountId: resolved.accountId, organizationId: resolved.organizationId }, "agents.manage");
    const input = z.strictObject({ name: z.string().min(1).max(120).optional(), avatar: options.avatarSchema.optional(),
      configuration: agentConfigurationSchema, expectedRevision: z.number().int().positive() }).parse(request.body);
    return { agent: options.present(await options.store.updateDraft({ ...input, accountId: resolved.accountId,
      organizationId: resolved.organizationId, agentId: agentId(request) })) };
  });

  app.patch(`${base}/agents/:agentId`, async request => {
    const resolved = await scope(request);
    await requirePermission(options.pool, { accountId: resolved.accountId, organizationId: resolved.organizationId }, "agents.manage");
    const input = z.strictObject({ name: z.string().min(1).max(120).optional(), avatar: options.avatarSchema.optional() })
      .refine(value => value.name !== undefined || value.avatar !== undefined, { message: "Nothing to update" }).parse(request.body);
    return { agent: options.present(await options.operations.profile(resolved, agentId(request), input)) };
  });

  app.put(`${base}/agents/:agentId/capabilities`, async request => {
    const resolved = await scope(request);
    await requirePermission(options.pool, { accountId: resolved.accountId, organizationId: resolved.organizationId }, "agents.manage");
    const result = await options.operations.setCapabilities(resolved, agentId(request), request.body);
    return { agent: options.present(result.agent), snapshot: options.present(result.snapshot) };
  });

  app.post(`${base}/agents/:agentId/configuration`, async request => {
    const resolved = await scope(request);
    await requirePermission(options.pool, { accountId: resolved.accountId, organizationId: resolved.organizationId }, "agents.manage");
    const result = await options.operations.save(resolved, agentId(request), request.body);
    request.log.info({ event: "agent.configuration.saved", agentId: result.agent.id, snapshotId: result.snapshot.id,
      organizationId: result.agent.organization_id }, "Agent configuration saved");
    return { agent: options.present(result.agent), snapshot: options.present(result.snapshot), deployments: result.deployments.map(options.present) };
  });

  app.post(`${base}/agents/:agentId/versions`, async (request, reply) => {
    const input = z.strictObject({ expectedRevision: z.number().int().positive() }).parse(request.body);
    const resolved = await scope(request);
    await requirePermission(options.pool, { accountId: resolved.accountId, organizationId: resolved.organizationId }, "agents.manage");
    const agent = await options.store.getAgent(resolved.accountId, resolved.organizationId, agentId(request));
    await options.assertBindings(agentConfigurationSchema.parse(agent.draft));
    return reply.code(201).send({ version: options.present(await options.store.createVersion({ ...input,
      accountId: resolved.accountId, organizationId: resolved.organizationId, agentId: agentId(request) })) });
  });

  app.post(`${base}/agents/:agentId/deployments`, async (request, reply) => {
    const input = z.strictObject({ versionId: uuid.optional(), allowedOrigins: z.array(z.string()).min(1).max(10) }).parse(request.body);
    const resolved = await scope(request);
    await requirePermission(options.pool, { accountId: resolved.accountId, organizationId: resolved.organizationId }, "deploy.manage");
    const publication = { accountId: resolved.accountId, organizationId: resolved.organizationId,
      agentId: agentId(request), allowedOrigins: input.allowedOrigins };
    const deployment = input.versionId
      ? await options.store.publishWebsite({ ...publication, versionId: input.versionId })
      : await options.store.publishCurrentWebsite(publication);
    return reply.code(201).send({ deployment: options.present(deployment) });
  });

  app.get(`${base}/offerings`, async request => {
    const resolved = await scope(request);
    await options.store.requireMembership(resolved.accountId, resolved.organizationId);
    return { offerings: options.offerings };
  });
}
