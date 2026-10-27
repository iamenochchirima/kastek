import type {EnquiryStore} from "../../capabilities/enquiries/enquiries";
import { channelKindSchema } from "../../contracts/channel-adapters";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ToolReviewStore } from "../../capabilities/reviews/tool-reviews";
import type { BookingService } from "../../workflows/booking/bookings";
import { PlatformError } from "../../contracts/contracts";
import { InboxStore, type CustomerConversation, type CustomerMessage, type InboxScope, type VisitorScope } from "./inbox-store";

const uuid = z.uuid(), sequence = z.string().regex(/^(0|[1-9][0-9]{0,17})$/), revision = z.string().regex(/^[1-9][0-9]{0,17}$/);
const page = z.object({ after: sequence.default("0"), before: revision.optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
export function inboxConversation(row: CustomerConversation) {
  const channel=row as CustomerConversation & {connection_id?:string;connection_name?:string;asset_id?:string};
  return { id: row.id, agentId: row.agent_id, deploymentId: row.deployment_id, versionId: row.version_id, channel: row.channel_kind ?? "website",
    channelDeploymentId: row.channel_deployment_id, externalConversationId: row.external_conversation_id,
    connectionId:channel.connection_id??null,connectionName:channel.connection_name??null,assetId:channel.asset_id??null,
    state: row.state, assigneeAccountId: row.assignee_account_id, assigneeDisplayName: row.assignee_display_name ?? null, revision: row.revision, ownershipGeneration: row.ownership_generation,
    createdAt: row.created_at, updatedAt: row.updated_at, agentName: (row as CustomerConversation & { agent_name?: string }).agent_name,
    customerName: row.customer_name ?? null, customerContactId: row.customer_contact_id ?? null,
    lastMessage: row.last_message_body != null && row.last_message_author_kind && row.last_message_created_at
      ? { body: row.last_message_body, authorKind: row.last_message_author_kind, createdAt: row.last_message_created_at } : null };
}
function message(row: CustomerMessage, staff: boolean) {
  return { id: row.id, sequence: row.sequence, authorKind: row.author_kind, body: row.body, createdAt: row.created_at,
    ...(staff ? { authorAccountId: row.author_account_id, taskId: row.task_id,channelFacts:row.channelFacts,deliveries:row.deliveries??[] } : {}) };
}
function visitorConversation(row: CustomerConversation) {
  return { id: row.id, state: row.state, channel: "website", versionId: row.version_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function registerInboxRoutes(app: FastifyInstance, options: {
  inbox: InboxStore;
  bookings?:BookingService;
  enquiries?:EnquiryStore;
  toolReviews?:ToolReviewStore;
  resolveScope(request: FastifyRequest): Promise<InboxScope>;
  resolveVisitor(request: FastifyRequest, reply: FastifyReply): Promise<VisitorScope>;
  publicRate?(deploymentId: string): Promise<void>;
}) {
  const params = (request: FastifyRequest) => z.object({ conversationId: uuid }).parse(request.params);
  const base = "/api/organizations/:organizationId/inbox";
  app.get(base, async request => {
    const scope = await options.resolveScope(request), filters = z.object({ state: z.enum(["automation_active", "handoff_pending", "human_owned", "resolved"]).optional(),
      agentId: uuid.optional(), channel: channelKindSchema.optional(), connectionId:uuid.optional(), assigned: z.enum(["mine", "unassigned"]).optional(), search: z.string().trim().max(200).optional(), cursor: z.string().min(1).max(2048).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const result = await options.inbox.list(scope, filters);
    return { conversations: result.items.map(inboxConversation), nextCursor: result.nextCursor };
  });
  app.get(`${base}/members`, async request => {
    const filters=z.object({search:z.string().trim().max(200).optional(),cursor:z.string().min(1).max(2048).optional(),limit:z.coerce.number().int().min(1).max(200).default(200)}).parse(request.query);
    const result=await options.inbox.members(await options.resolveScope(request),filters);
    return {members:result.items.map(row=>({id:row.id,displayName:row.display_name})),nextCursor:result.nextCursor};
  });
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
  if(options.enquiries){
    const enquiries=options.enquiries;
    app.get(`${base}/:conversationId/enquiries`,async request=>{const scope=await options.resolveScope(request),conversationId=params(request).conversationId;await options.inbox.readStaff(scope,conversationId,"0",1);return {enquiries:await enquiries.listStaff(scope,{conversationId})};});
  }
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
  if(options.enquiries){
    const enquiries=options.enquiries;
    const enquiryTasks=async(request:FastifyRequest,reply:FastifyReply)=>{
      const scope=await options.resolveVisitor(request,reply);await options.publicRate?.(scope.deploymentId);
      const result=await options.inbox.readVisitor(scope,params(request).conversationId,"0",1);
      const principal={kind:"visitor" as const,deploymentId:scope.deploymentId,sessionId:scope.sessionId};
      const rows=(await options.inbox.pool.query(`SELECT DISTINCT t.id FROM agents_platform.tasks t JOIN agents_platform.enquiries e ON e.task_id=t.id WHERE t.conversation_id=$1 AND t.principal=$2::jsonb AND t.organization_id=$3 ORDER BY t.id LIMIT 30`,[result.conversation.execution_conversation_id,JSON.stringify(principal),result.conversation.organization_id])).rows;
      return {principal,rows,conversation:result.conversation};
    };
    app.get(`${website}/:conversationId/enquiries`,async(request,reply)=>{const current=await enquiryTasks(request,reply);return {enquiries:(await Promise.all(current.rows.map(row=>enquiries.listForPrincipal(row.id,current.principal)))).flat()};});
    app.post(`${website}/:conversationId/enquiries/:enquiryId/decision`,async(request,reply)=>{
      const current=await enquiryTasks(request,reply);if(current.conversation.state!=="automation_active")throw new PlatformError("ENQUIRY_REVIEW_DENIED",403,"Enquiry confirmation is unavailable");
      const id=uuid.parse((request.params as Record<string,string>).enquiryId),input=z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body);
      for(const row of current.rows){const items=await enquiries.listForPrincipal(row.id,current.principal);if(items.some(item=>item.id===id))return {enquiry:await enquiries.decide(row.id,current.principal,id,input)};}
      throw new PlatformError("ENQUIRY_NOT_FOUND",404,"Enquiry not found");
    });
  }
  if(options.toolReviews) {
    const reviews=options.toolReviews;
    const reviewTasks=async(request:FastifyRequest,reply:FastifyReply)=>{
      const scope=await options.resolveVisitor(request,reply);
      const result=await options.inbox.readVisitor(scope,params(request).conversationId,"0",1);
      const principal={kind:"visitor" as const,deploymentId:scope.deploymentId,sessionId:scope.sessionId};
      const rows=(await options.inbox.pool.query(`SELECT DISTINCT t.id FROM agents_platform.tasks t
        JOIN agents_platform.tool_invocation_reviews r ON r.task_id=t.id
        WHERE t.conversation_id=$1 AND t.principal=$2::jsonb AND t.organization_id=$3 ORDER BY t.id LIMIT 30`,
        [result.conversation.execution_conversation_id,JSON.stringify(principal),result.conversation.organization_id])).rows;
      return {scope,principal,rows,conversation:result.conversation};
    };
    app.get(`${website}/:conversationId/tool-reviews`,async(request,reply)=>{
      const current=await reviewTasks(request,reply);await options.publicRate?.(current.scope.deploymentId);
      return {reviews:(await Promise.all(current.rows.map(row=>reviews.listForPrincipal(row.id,current.principal)))).flat()};
    });
    app.post(`${website}/:conversationId/tool-reviews/:reviewId/decision`,async(request,reply)=>{
      const current=await reviewTasks(request,reply);await options.publicRate?.(current.scope.deploymentId);
      if(current.conversation.state!=="automation_active")throw new PlatformError("TOOL_REVIEW_DENIED",403,"Contact confirmation is unavailable");
      const id=uuid.parse((request.params as Record<string,string>).reviewId);
      const input=z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body);
      for(const row of current.rows){
        const items=await reviews.listForPrincipal(row.id,current.principal);
        if(items.some(item=>item.id===id))return {review:await reviews.decideForPrincipal(row.id,current.principal,id,input)};
      }
      throw new PlatformError("TOOL_REVIEW_NOT_FOUND",404,"Contact confirmation not found");
    });
  }
  app.post(`${website}/:conversationId/messages`, async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply); await options.publicRate?.(scope.deploymentId);
    const input = z.strictObject({ requestKey: z.string().min(1).max(100), body: z.string().trim().min(1).max(8000) }).parse(request.body);
    const result = await options.inbox.ingress(scope, params(request).conversationId, input);
    return reply.code(result.replayed ? 200 : 201).send({ conversation: visitorConversation(result.conversation), message: message(result.message, false), replayed: result.replayed });
  });
}
