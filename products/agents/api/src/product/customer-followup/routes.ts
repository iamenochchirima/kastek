import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { PlatformError } from "../../contracts/contracts";
import type { CustomerFollowupChallenges } from "./challenges";
import type { NotificationMessage, NotificationResult } from "../../adapters/notifications/resend";

/** Requires the existing website origin and visitor-session resolver and a rate-limited POST. */
export function registerCustomerFollowupReturn(app: FastifyInstance, options: {
  challenges: CustomerFollowupChallenges;
  resolveVisitor: (request: FastifyRequest, reply: FastifyReply) => Promise<{ deploymentId: string; sessionId: string }>;
  publicRate: (deploymentId: string) => Promise<void>;
}) {
  app.post("/api/website/:deploymentId/followup/return", async (request, reply) => {
    const scope = await options.resolveVisitor(request, reply); await options.publicRate(scope.deploymentId);
    const input = z.strictObject({ secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(request.body);
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    return options.challenges.exchangeReturn(scope, input.secret);
  });
}

/** Preference reads and revocation remain available when new signups are unavailable. */
export function registerCustomerFollowupConsent(app: FastifyInstance, options: {
  challenges: CustomerFollowupChallenges;
  resolveVisitor: (request: FastifyRequest, reply: FastifyReply) => Promise<{ deploymentId: string; sessionId: string }>;
  publicRate: (deploymentId: string) => Promise<void>;
  send?: (message: NotificationMessage) => Promise<NotificationResult>;
  ready?: () => Promise<boolean>;
}) {
  const route = "/api/website/:deploymentId/customer-conversations/:conversationId/followup";
  const scope = async (request: FastifyRequest, reply: FastifyReply) => {
    const visitor = await options.resolveVisitor(request, reply); await options.publicRate(visitor.deploymentId);
    const { conversationId } = z.strictObject({ deploymentId: z.uuid(), conversationId: z.uuid() }).parse(request.params);
    reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
    return { ...visitor, conversationId };
  };
  app.post(`${route}/request`, async (request, reply) => {
    const visitor = await scope(request, reply), input = z.strictObject({ email: z.email().max(254), confirmed: z.literal(true) }).parse(request.body);
    if(!options.send||options.ready&&!await options.ready())throw new PlatformError("FOLLOWUP_EMAIL_UNAVAILABLE",503,"Email notifications are unavailable");
    const verification = await options.challenges.requestVerification(visitor, input.email);
    const result = await options.send({ to: verification.email, subject: "Confirm support notifications", text: `Your confirmation code is:\n\n${verification.secret}\n\nEnter this code in the chat to receive notifications about human support replies.`, idempotencyKey: `verify_${createHash("sha256").update(verification.secret).digest("hex")}` });
    if (result.state !== "accepted") throw new PlatformError("FOLLOWUP_EMAIL_UNAVAILABLE", 503, "Confirmation email could not be sent");
    return { state: "confirmation_sent" };
  });
  app.post(`${route}/verify`, async (request, reply) => {
    const visitor = await scope(request, reply), input = z.strictObject({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).parse(request.body);
    await options.challenges.verifyEmail(visitor, input.code); return { state: "verified" };
  });
  app.post(`${route}/revoke`, async (request, reply) => { await options.challenges.revoke(await scope(request, reply)); return { state: "revoked" }; });
  app.get(route, async (request, reply) => ({ state: await options.challenges.preference(await scope(request, reply)) }));
  app.post(`${route}/read`, async (request, reply) => {
    const visitor = await scope(request, reply), input = z.strictObject({ sequence: z.string().regex(/^[1-9][0-9]{0,17}$/) }).parse(request.body);
    await options.challenges.markRead(visitor, input.sequence); return { state: "recorded" };
  });
}
