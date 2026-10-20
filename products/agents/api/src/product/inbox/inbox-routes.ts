import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BookingService } from "../../workflows/booking/bookings";
import { PlatformError } from "../../contracts/contracts";
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
  bookings?:BookingService;
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
    const hasBookings=!!(await options.inbox.pool.query(`SELECT 1 FROM agents_platform.customer_task_links l
      JOIN agents_platform.tasks t ON t.id=l.task_id JOIN agents_platform.booking_intents b ON b.task_id=t.id
      WHERE l.conversation_id=$1 AND t.organization_id=$2 LIMIT 1`,[conversationId,scope.organizationId])).rowCount;
    return { conversation: {...inboxConversation(result.conversation),hasBookings}, messages: result.messages.map(row => message(row, true)), nextSequence: result.messages.at(-1)?.sequence ?? input.after, latestSequence: String(BigInt(result.conversation.next_sequence) - 1n), earlierBefore: result.messages[0] && BigInt(result.messages[0].sequence) > 1n ? result.messages[0].sequence : null };
  });
  app.post(`${base}/:conversationId/commands`, async request => {
    const input = z.strictObject({ commandId: uuid, expectedRevision: revision, action: z.enum(["claim", "assign", "unassign", "takeover", "reply", "resolve", "reopen", "return"]), assigneeAccountId: uuid.nullable().optional(), body: z.string().trim().min(1).max(8000).optional() }).parse(request.body);
    return { conversation: inboxConversation(await options.inbox.command(await options.resolveScope(request), params(request).conversationId, input)) };
  });
  if(options.bookings){
    const bookings=options.bookings;
    const staffBookingTasks=async(request:FastifyRequest,bookingId?:string)=>{
      const scope=await options.resolveScope(request),conversationId=params(request).conversationId;
      await options.inbox.readStaff(scope,conversationId,"0",1);
      const rows=(await options.inbox.pool.query(`SELECT DISTINCT t.id,t.principal,t.created_at FROM agents_platform.customer_task_links l
        JOIN agents_platform.tasks t ON t.id=l.task_id JOIN agents_platform.booking_intents b ON b.task_id=t.id
        WHERE l.conversation_id=$1 AND t.organization_id=$2 AND ($3::uuid IS NULL OR b.id=$3::uuid)
        ORDER BY t.created_at DESC,t.id LIMIT 30`,[conversationId,scope.organizationId,bookingId??null])).rows;
      return {scope,rows};
    };
    app.get(`${base}/:conversationId/bookings`,async request=>{
      const current=await staffBookingTasks(request);
      return {bookings:(await Promise.all(current.rows.map(row=>bookings.listForPrincipal(row.id,row.principal)))).flat()};
    });
    app.post(`${base}/:conversationId/bookings/:bookingId/reconcile`,async request=>{
      const id=uuid.parse((request.params as Record<string,string>).bookingId),current=await staffBookingTasks(request,id);
      if(!current.rows.length)throw new PlatformError("BOOKING_NOT_FOUND",404,"Booking not found");
      return {booking:await bookings.reconcile(current.rows[0].id,current.rows[0].principal,id,current.scope)};
    });
  }
  const website = "/api/website/:deploymentId/customer-conversations";
  app.post(website, async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply); await options.publicRate?.(scope.deploymentId);
    return { conversation: visitorConversation(await options.inbox.open(scope)) };
  });
  app.get(`${website}/:conversationId/messages`, async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply), input = page.parse(request.query), result = await options.inbox.readVisitor(scope, params(request).conversationId, input.after, input.limit, input.before);
    return { conversation: visitorConversation(result.conversation), messages: result.messages.map(row => message(row, false)), nextSequence: result.messages.at(-1)?.sequence ?? input.after, latestSequence: String(BigInt(result.conversation.next_sequence) - 1n), earlierBefore: result.messages[0] && BigInt(result.messages[0].sequence) > 1n ? result.messages[0].sequence : null };
  });
  if(options.bookings) {
    const bookings=options.bookings;
    const publicBooking=(booking:Awaited<ReturnType<BookingService["listForPrincipal"]>>[number])=>({id:booking.id,state:booking.state,start:booking.start,end:booking.end,timeZone:booking.timeZone,title:booking.title,requestDigest:booking.requestDigest,expiresAt:booking.expiresAt});
    const bookingTask=async(request:FastifyRequest,reply:FastifyReply)=>{
      const scope=await options.resolveVisitor(request,reply),conversation=await options.inbox.readVisitor(scope,params(request).conversationId,"0",1);
      const principal={kind:"visitor" as const,deploymentId:scope.deploymentId,sessionId:scope.sessionId};
      const rows=(await options.inbox.pool.query(`SELECT DISTINCT t.id FROM agents_platform.tasks t JOIN agents_platform.booking_intents b ON b.task_id=t.id
        WHERE t.conversation_id=$1 AND t.principal=$2::jsonb ORDER BY t.id LIMIT 30`,[conversation.conversation.execution_conversation_id,JSON.stringify(principal)])).rows;
      return {scope,principal,rows};
    };
    app.get(`${website}/:conversationId/bookings`,async(request,reply)=>{
      const current=await bookingTask(request,reply);
      return {bookings:(await Promise.all(current.rows.map(row=>bookings.listForPrincipal(row.id,current.principal)))).flat().map(publicBooking)};
    });
    app.post(`${website}/:conversationId/bookings/:bookingId/reconcile`,async(request,reply)=>{
      const current=await bookingTask(request,reply);await options.publicRate?.(current.scope.deploymentId);
      const id=uuid.parse((request.params as Record<string,string>).bookingId);
      for(const row of current.rows){const scoped=await bookings.listForPrincipal(row.id,current.principal);if(scoped.some(booking=>booking.id===id))return {booking:publicBooking(await bookings.reconcile(row.id,current.principal,id))};}
      throw new PlatformError("BOOKING_NOT_FOUND",404,"Booking not found");
    });
    app.post(`${website}/:conversationId/bookings/:bookingId/decision`,async(request,reply)=>{
      const current=await bookingTask(request,reply);await options.publicRate?.(current.scope.deploymentId);
      const id=uuid.parse((request.params as Record<string,string>).bookingId),input=z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body);
      for(const row of current.rows){const scoped=await bookings.listForPrincipal(row.id,current.principal);if(scoped.some(booking=>booking.id===id))return {booking:publicBooking(await bookings.decide(row.id,current.principal,id,input))};}
      throw new PlatformError("BOOKING_NOT_FOUND",404,"Booking not found");
    });
  }
  app.post(`${website}/:conversationId/messages`, async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply); await options.publicRate?.(scope.deploymentId);
    const input = z.strictObject({ requestKey: z.string().min(1).max(100), body: z.string().trim().min(1).max(8000) }).parse(request.body);
    const result = await options.inbox.ingress(scope, params(request).conversationId, input);
    return reply.code(result.replayed ? 200 : 201).send({ conversation: visitorConversation(result.conversation), message: message(result.message, false), replayed: result.replayed });
  });
}
