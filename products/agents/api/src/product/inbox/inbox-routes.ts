import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { InboxStore, type CustomerConversation, type CustomerMessage, type InboxScope, type VisitorScope } from "./inbox-store";

const uuid = z.uuid(), sequence = z.string().regex(/^(0|[1-9][0-9]{0,17})$/), revision = z.string().regex(/^[1-9][0-9]{0,17}$/);
const page = z.object({ after: sequence.default("0"), before: revision.optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
export function inboxConversation(row: CustomerConversation) {
  return { id: row.id, agentId: row.agent_id, deploymentId: row.deployment_id, versionId: row.version_id, channel: "website" as const,
    state: row.state, assigneeAccountId: row.assignee_account_id, revision: row.revision, ownershipGeneration: row.ownership_generation,
    createdAt: row.created_at, updatedAt: row.updated_at, agentName: (row as CustomerConversation & { agent_name?: string }).agent_name };
}
function message(row: CustomerMessage, staff: boolean) {
  return { id: row.id, sequence: row.sequence, authorKind: row.author_kind, body: row.body, createdAt: row.created_at,
    ...(staff ? { authorAccountId: row.author_account_id, taskId: row.task_id } : {}) };
}
function visitorConversation(row: CustomerConversation) {
  return { id: row.id, state: row.state, channel: "website", versionId: row.version_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function registerInboxRoutes(app: FastifyInstance, options: {
  inbox: InboxStore;
  resolveScope(request: FastifyRequest): Promise<InboxScope>;
  resolveVisitor(request: FastifyRequest, reply: FastifyReply): Promise<VisitorScope>;
  publicRate?(deploymentId: string): Promise<void>;
}) {
  const params = (request: FastifyRequest) => z.object({ conversationId: uuid }).parse(request.params);
  const base = "/api/organizations/:organizationId/inbox";
  app.get(base, async request => {
    const scope = await options.resolveScope(request), filters = z.object({ state: z.enum(["automation_active", "handoff_pending", "human_owned", "resolved"]).optional(),
      agentId: uuid.optional(), channel: z.literal("website").optional(), assigned: z.enum(["mine", "unassigned"]).optional(), cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const result = await options.inbox.list(scope, filters);
    return { conversations: result.items.map(inboxConversation), nextCursor: result.nextCursor };
  });
  app.get(`${base}/members`, async request => ({ members: (await options.inbox.members(await options.resolveScope(request))).map(row => ({ id: row.id, displayName: row.display_name })) }));
  app.get(`${base}/:conversationId`, async request => {
    const scope = await options.resolveScope(request), { conversationId } = params(request), input = page.parse(request.query), result = await options.inbox.readStaff(scope, conversationId, input.after, input.limit, input.before);
    return { conversation: inboxConversation(result.conversation), messages: result.messages.map(row => message(row, true)), nextSequence: result.messages.at(-1)?.sequence ?? input.after, latestSequence: String(BigInt(result.conversation.next_sequence) - 1n), earlierBefore: result.messages[0] && BigInt(result.messages[0].sequence) > 1n ? result.messages[0].sequence : null };
  });
  app.post(`${base}/:conversationId/commands`, async request => {
    const input = z.strictObject({ commandId: uuid, expectedRevision: revision, action: z.enum(["claim", "assign", "unassign", "takeover", "reply", "resolve", "reopen", "return"]), assigneeAccountId: uuid.nullable().optional(), body: z.string().trim().min(1).max(8000).optional() }).parse(request.body);
    return { conversation: inboxConversation(await options.inbox.command(await options.resolveScope(request), params(request).conversationId, input)) };
  });
  const website = "/api/website/:deploymentId/customer-conversations";
  app.post(website, async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply); await options.publicRate?.(scope.deploymentId);
    return { conversation: visitorConversation(await options.inbox.open(scope)) };
  });
  app.get(`${website}/:conversationId/messages`, async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply), input = page.parse(request.query), result = await options.inbox.readVisitor(scope, params(request).conversationId, input.after, input.limit, input.before);
    return { conversation: visitorConversation(result.conversation), messages: result.messages.map(row => message(row, false)), nextSequence: result.messages.at(-1)?.sequence ?? input.after, latestSequence: String(BigInt(result.conversation.next_sequence) - 1n), earlierBefore: result.messages[0] && BigInt(result.messages[0].sequence) > 1n ? result.messages[0].sequence : null };
  });
  app.post(`${website}/:conversationId/messages`, async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply); await options.publicRate?.(scope.deploymentId);
    const input = z.strictObject({ requestKey: z.string().min(1).max(100), body: z.string().trim().min(1).max(8000) }).parse(request.body);
    const result = await options.inbox.ingress(scope, params(request).conversationId, input);
    return reply.code(result.replayed ? 200 : 201).send({ conversation: visitorConversation(result.conversation), message: message(result.message, false), replayed: result.replayed });
  });
}
