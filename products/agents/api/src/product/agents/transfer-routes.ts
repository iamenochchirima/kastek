import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Account } from "../../contracts/records";
import { AgentTransferStore, type TransferEmail } from "./transfer-store";

const uuid = z.uuid();
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const initiateBody = z.strictObject({ email: z.email().max(254) });
const acceptBody = z.strictObject({ organizationId: z.uuid() });

export type TransferEmailSender = (input: TransferEmail) => Promise<void>;

export function registerAgentTransferRoutes(app: FastifyInstance, options: {
  store: AgentTransferStore;
  resolveScope(request: FastifyRequest): Promise<{ accountId: string; organizationId: string }>;
  account(request: FastifyRequest): Promise<Account>;
  sendTransfer: TransferEmailSender;
}) {
  const base = "/api/organizations/:organizationId";
  const params = (request: FastifyRequest) => request.params as Record<string, string>;

  app.post(`${base}/agents/:agentId/transfers`, async (request, reply) => {
    const scope = await options.resolveScope(request);
    const agentId = uuid.parse(params(request).agentId);
    const input = initiateBody.parse(request.body ?? {});
    const initiated = await options.store.initiate(scope, agentId, input.email);
    try {
      await options.sendTransfer(initiated);
    } catch (error) {
      await options.store.cancelInitiation(initiated.transfer.id);
      request.log.error({ event: "agent.transfer_email_failed", organizationId: scope.organizationId, agentId, transferId: initiated.transfer.id },
        "Agent transfer email failed");
      throw error;
    }
    request.log.info({ event: "agent.transfer_initiated", organizationId: scope.organizationId, agentId, transferId: initiated.transfer.id },
      "Agent transfer initiated");
    return reply.code(201).send({ transfer: initiated.transfer });
  });

  app.get(`${base}/agents/:agentId/transfers/current`, async request => {
    const scope = await options.resolveScope(request);
    return { transfer: await options.store.current(scope, uuid.parse(params(request).agentId)) };
  });

  app.delete(`${base}/agents/:agentId/transfers/:transferId`, async (request, reply) => {
    const scope = await options.resolveScope(request);
    await options.store.cancel(scope, uuid.parse(params(request).agentId), uuid.parse(params(request).transferId));
    request.log.info({ event: "agent.transfer_cancelled", organizationId: scope.organizationId, agentId: params(request).agentId, transferId: params(request).transferId },
      "Agent transfer cancelled");
    return reply.code(204).send();
  });

  app.get("/api/agent-transfers/:token", async request => {
    return { transfer: await options.store.preview(token.parse(params(request).token)) };
  });

  app.post("/api/agent-transfers/:token/decline", async request => {
    const user = await options.account(request);
    await options.store.decline(user.id, token.parse(params(request).token));
    request.log.info({ event: "agent.transfer_declined", accountId: user.id }, "Agent transfer declined");
    return { message: "Transfer declined" };
  });

  app.post("/api/agent-transfers/:token/accept", async request => {
    const user = await options.account(request);
    const input = acceptBody.parse(request.body ?? {});
    const accepted = await options.store.accept(user.id, token.parse(params(request).token), input.organizationId);
    request.log.info({ event: "agent.transfer_accepted", accountId: user.id, organizationId: accepted.organizationId, agentId: accepted.agentId },
      "Agent transfer accepted");
    return accepted;
  });
}
