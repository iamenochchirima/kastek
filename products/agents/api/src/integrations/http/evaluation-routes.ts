import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import type { Account } from "../../contracts/records";

export type EvaluationScope = { accountId: string; organizationId: string };
export type EvaluationRequestScope = { account: Account; organizationId: string };
type Trial = { id: string };

/** Evaluation trials, as used by the HTTP routes. Product-owned behaviour arrives as a port. */
export interface EvaluationTrialPort {
  preview(accountId: string, organizationId: string, agentId: string, raw: unknown): Promise<unknown>;
  prepare(accountId: string, organizationId: string, raw: unknown): Promise<Trial>;
  get(accountId: string, organizationId: string, query: { id?: string; trialId?: string }): Promise<{ trial: Trial | null; rootTaskIds: unknown[] }>;
  channelSession(accountId: string, organizationId: string, trialId: string, raw: unknown, secret: string): Promise<unknown>;
  revoke(accountId: string, organizationId: string, trialId: string): Promise<unknown>;
}

export interface EvaluationChannelPort {
  prepare(scope: EvaluationScope, trialId: string, raw: unknown): Promise<unknown>;
  ingress(scope: EvaluationScope, trialId: string, raw: unknown): Promise<unknown>;
  history(scope: EvaluationScope, trialId: string): Promise<object>;
}

/**
 * Evaluation trial routes for authenticated workspace members. Paths and payloads stay unchanged
 * while the handlers move out of composition. Trial and channel behaviour arrive as ports.
 */
export function registerEvaluationRoutes(app: FastifyInstance, options: {
  pool: Pool;
  trials: EvaluationTrialPort;
  parseTrial(raw: unknown): unknown;
  fixtures?: EvaluationChannelPort;
  signingSecret?: string;
  inbox: { readStaff(scope: EvaluationScope, conversationId: string): Promise<object> };
  resolveScope(request: FastifyRequest): Promise<EvaluationRequestScope>;
}) {
  const base = "/api/organizations/:organizationId";
  const uuid = z.uuid();
  const parameters = (request: FastifyRequest) => request.params as Record<string, string>;
  const trialId = (request: FastifyRequest) => uuid.parse(parameters(request).trialId);
  const unavailable = () => new PlatformError("EVALUATION_CHANNEL_UNAVAILABLE", 503, "Isolated channel storage is unavailable");

  app.post(`${base}/agents/:agentId/model-preview`, async request => {
    const { account, organizationId } = await options.resolveScope(request);
    return options.trials.preview(account.id, organizationId, uuid.parse(parameters(request).agentId), request.body);
  });

  app.post(`${base}/evaluation-trials`, async (request, reply) => {
    const { account, organizationId } = await options.resolveScope(request);
    const trial = await options.trials.prepare(account.id, organizationId, options.parseTrial(request.body));
    return reply.code(201).send({ trial, submitPath: `/api/organizations/${organizationId}/tasks`, taskBinding: { evaluationTrialId: trial.id },
      revokePath: `/api/organizations/${organizationId}/evaluation-trials/${trial.id}/revoke` });
  });

  app.get(`${base}/evaluation-trials`, async request => {
    const query = z.strictObject({ trialId: z.string().min(1).max(128) }).parse(request.query);
    const { account, organizationId } = await options.resolveScope(request);
    return options.trials.get(account.id, organizationId, query);
  });

  app.get(`${base}/evaluation-trials/:trialId`, async request => {
    const { account, organizationId } = await options.resolveScope(request);
    return options.trials.get(account.id, organizationId, { id: trialId(request) });
  });

  app.post(`${base}/evaluation-trials/:trialId/channel-session`, async request => {
    if (!options.signingSecret) throw new PlatformError("EVALUATION_CHANNEL_UNAVAILABLE", 503, "Evaluation channels require the configured signing secret");
    const { account, organizationId } = await options.resolveScope(request);
    return options.trials.channelSession(account.id, organizationId, trialId(request), request.body, options.signingSecret);
  });

  app.post(`${base}/evaluation-trials/:trialId/channel-fixture`, async request => {
    if (!options.fixtures) throw unavailable();
    const scope = await options.resolveScope(request);
    return options.fixtures.prepare({ accountId: scope.account.id, organizationId: scope.organizationId }, trialId(request), request.body);
  });

  app.post(`${base}/evaluation-trials/:trialId/channel-fixture/ingress`, async request => {
    if (!options.fixtures) throw unavailable();
    const scope = await options.resolveScope(request);
    return options.fixtures.ingress({ accountId: scope.account.id, organizationId: scope.organizationId }, trialId(request), request.body);
  });

  app.get(`${base}/evaluation-trials/:trialId/channel-history`, async request => {
    const { account, organizationId } = await options.resolveScope(request), id = trialId(request);
    const trial = await options.trials.get(account.id, organizationId, { id });
    if (!trial.trial) throw new PlatformError("NOT_FOUND", 404, "Trial not found");
    if ((await options.pool.query("SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels WHERE trial_id=$1 AND organization_id=$2",
      [id, organizationId])).rowCount) {
      if (!options.fixtures) throw unavailable();
      return options.fixtures.history({ accountId: account.id, organizationId }, id);
    }
    const channel = (await options.pool.query(`SELECT c.id FROM agents_platform.evaluation_trial_channels e
      JOIN agents_platform.customer_conversations c ON c.session_id=e.session_id AND c.deployment_id=e.deployment_id
      WHERE e.trial_id=$1 AND c.organization_id=$2`, [id, organizationId])).rows[0];
    if (!channel) return { conversation: null, messages: [], commands: [], deliveries: [], rootTaskIds: trial.rootTaskIds };
    const history = await options.inbox.readStaff({ accountId: account.id, organizationId }, channel.id);
    const commands = (await options.pool.query(`SELECT command_id,action,actor_account_id,created_at FROM agents_platform.customer_commands WHERE conversation_id=$1 ORDER BY created_at,command_id LIMIT 1000`,
      [channel.id])).rows;
    const deliveries = (await options.pool.query(`SELECT id,task_id,message_id,ownership_generation,state,reason,created_at FROM agents_platform.customer_deliveries WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 1000`,
      [channel.id])).rows;
    return { ...history, commands, deliveries, rootTaskIds: trial.rootTaskIds };
  });

  app.post(`${base}/evaluation-trials/:trialId/revoke`, async request => {
    z.strictObject({}).parse(request.body ?? {});
    const { account, organizationId } = await options.resolveScope(request);
    return options.trials.revoke(account.id, organizationId, trialId(request));
  });
}
