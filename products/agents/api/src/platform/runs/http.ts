import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { taskStateSchema, terminalTaskStates, PlatformError, type AdmissionAuthority, type TaskState } from "../../contracts/contracts";
import type { Account, TaskRecord } from "../../contracts/records";
import { requestTreeCancellation } from "../../execution/lifecycle/execution";
import { pageQuery, type PageQuery } from "../../infrastructure/read-pages";

export type RunScope = { account: Account; organizationId: string };

/** Task and conversation access, as used by the read and control routes. */
export interface RunHttpStorePort {
  requireMembership(accountId: string, organizationId: string): Promise<void>;
  getEventPage(authority: AdmissionAuthority, taskId: string, query: PageQuery): Promise<{ items: object[]; nextCursor: string | null }>;
  getConversationPage(authority: AdmissionAuthority, conversationId: string, query: PageQuery):
    Promise<{ items: TaskRecord[]; nextCursor: string | null; conversation: unknown }>;
}

export interface RunDiscoveryPort {
  conversations(account: Account, organizationId: string,
    query: PageQuery & { agentId: string; versionId?: string; state?: "active" | "archived" }):
    Promise<{ items: object[]; nextCursor: string | null }>;
  tasks(account: Account, organizationId: string, query: PageQuery & { agentId?: string; state?: TaskState }):
    Promise<{ items: object[]; nextCursor: string | null }>;
}

const summary = (value: object) => { const { position: _position, ...row } = value as Record<string, unknown>; return row; };
const humanAuthority = (user: Account, organizationId: string, resourceId: string): AdmissionAuthority => ({
  product: "agents", organizationId, resourceId, callerClientId: "agents-execution",
  principal: { kind: "human", issuer: user.issuer, subject: user.subject },
});

/**
 * Task and conversation read and control routes. Paths and payloads stay unchanged while the
 * handlers move out of composition. Authorization decisions arrive through ports.
 */
export function registerRunReadRoutes(app: FastifyInstance, options: {
  pool: Pool;
  store: RunHttpStorePort;
  discovery: RunDiscoveryPort;
  taskAccess(request: FastifyRequest): Promise<{ task: TaskRecord; authority: AdmissionAuthority; reviewOnly: boolean }>;
  presentTask(task: TaskRecord): Promise<Record<string, unknown>>;
  deleteConversationSources(scope: { accountId: string; organizationId: string; agentId: string }, conversationId: string): Promise<unknown>;
  resolveScope(request: FastifyRequest): Promise<RunScope>;
  present(record: object): object;
}) {
  const base = "/api/organizations/:organizationId";
  const uuid = z.uuid();
  const parameters = (request: FastifyRequest) => request.params as Record<string, string>;

  app.get(`${base}/conversations`, async request => {
    const { account, organizationId } = await options.resolveScope(request);
    const query = pageQuery.extend({ agentId: uuid, versionId: uuid.optional(), state: z.enum(["active", "archived"]).optional() })
      .strict().parse(request.query);
    const page = await options.discovery.conversations(account, organizationId, query);
    return { conversations: page.items.map(row => summary(row)), nextCursor: page.nextCursor };
  });

  app.get(`${base}/tasks`, async request => {
    const { account, organizationId } = await options.resolveScope(request);
    const query = pageQuery.extend({ agentId: uuid.optional(), state: taskStateSchema.optional() }).strict().parse(request.query);
    const page = await options.discovery.tasks(account, organizationId, query);
    return { tasks: page.items.map(row => summary(row)), nextCursor: page.nextCursor };
  });

  app.get(`${base}/tasks/:taskId/events`, async request => {
    const { task, authority, reviewOnly } = await options.taskAccess(request);
    const query = pageQuery.strict().parse(request.query);
    if (reviewOnly) return { events: [], nextCursor: null };
    const page = await options.store.getEventPage(authority, task.id, query);
    return { events: page.items.map(options.present), nextCursor: page.nextCursor };
  });

  app.post(`${base}/tasks/:taskId/cancel`, async request => {
    const { task } = await options.taskAccess(request), { account } = await options.resolveScope(request);
    if (task.principal.kind === "automation" && account.id !== task.principal.ownerAccountId)
      throw new PlatformError("ACCESS_DENIED", 403, "Only the owner can stop this task");
    if (task.parent_task_id) throw new PlatformError("ROOT_CONTROL_REQUIRED", 409, "Cancel the main task");
    if (!terminalTaskStates.has(task.state)) await requestTreeCancellation(options.pool, task.id);
    return { task: options.present((await options.taskAccess(request)).task) };
  });

  app.get(`${base}/conversations/:conversationId`, async request => {
    const { account, organizationId } = await options.resolveScope(request);
    const conversationId = uuid.parse(parameters(request).conversationId);
    await options.store.requireMembership(account.id, organizationId);
    const conversation = (await options.pool.query<{ agent_id: string }>(
      "SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2", [organizationId, conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
    const page = await options.store.getConversationPage(humanAuthority(account, organizationId, conversation.agent_id),
      conversationId, pageQuery.strict().parse(request.query));
    return { tasks: await Promise.all(page.items.map(options.presentTask)), nextCursor: page.nextCursor, conversation: page.conversation };
  });

  app.delete(`${base}/conversations/:conversationId`, async request => {
    const { account, organizationId } = await options.resolveScope(request);
    const conversationId = uuid.parse(parameters(request).conversationId);
    const conversation = (await options.pool.query("SELECT agent_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2",
      [organizationId, conversationId])).rows[0];
    if (!conversation) throw new PlatformError("NOT_FOUND", 404, "Conversation not found");
    return options.deleteConversationSources({ accountId: account.id, organizationId, agentId: conversation.agent_id }, conversationId);
  });

}
