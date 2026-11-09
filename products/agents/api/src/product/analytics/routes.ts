import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { assertAgentsBillingFeature } from "../billing/billing";

const inboxAnalyticsSql = `
  WITH bounds AS (
    SELECT
      (date_trunc('day', now() AT TIME ZONE 'UTC') - ($2::int - 1) * interval '1 day') AT TIME ZONE 'UTC' AS start_at,
      now() AS end_at
  ),
  conversations AS (
    SELECT c.id, c.channel_kind, c.state, c.assignee_account_id
    FROM agents_platform.customer_conversations c
    WHERE c.organization_id = $1
      AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id = c.session_id)
      AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id = c.channel_deployment_id)
  ),
  period_handoffs AS (
    SELECT h.id, h.conversation_id, h.requested_at, c.channel_kind
    FROM agents_platform.human_assistance_requests h
    JOIN conversations c ON c.id = h.conversation_id
    CROSS JOIN bounds b
    WHERE h.organization_id = $1
      AND h.requested_at >= b.start_at
      AND h.requested_at <= b.end_at
  ),
  handoff_daily AS (
    SELECT
      to_char(day, 'YYYY-MM-DD') AS date,
      (SELECT count(*)::int FROM period_handoffs h WHERE (h.requested_at AT TIME ZONE 'UTC')::date = day::date) AS count
    FROM generate_series(
      (SELECT start_at AT TIME ZONE 'UTC' FROM bounds),
      date_trunc('day', now() AT TIME ZONE 'UTC'),
      interval '1 day'
    ) AS day
  ),
  channel_totals AS (
    SELECT channel_kind AS channel, count(*)::int AS count
    FROM period_handoffs
    GROUP BY channel_kind
  ),
  first_replies AS (
    SELECT
      w.requested_at,
      (
        SELECT min(m.created_at)
        FROM agents_platform.customer_messages m
        WHERE m.conversation_id = w.conversation_id
          AND m.author_kind = 'human'
          AND m.created_at >= w.requested_at
          AND m.ownership_generation >= w.ownership_generation
      ) AS first_reply_at
    FROM agents_platform.support_waiting w
    JOIN conversations c ON c.id = w.conversation_id
    CROSS JOIN bounds b
    WHERE w.requested_at >= b.start_at
      AND w.requested_at <= b.end_at
  ),
  resolved AS (
    SELECT count(DISTINCT cmd.conversation_id)::int AS count
    FROM agents_platform.customer_commands cmd
    JOIN conversations c ON c.id = cmd.conversation_id
    CROSS JOIN bounds b
    WHERE cmd.action = 'resolve'
      AND cmd.created_at >= b.start_at
      AND cmd.created_at <= b.end_at
  )
  SELECT json_build_object(
    'period', json_build_object('days', $2::int),
    'counts', json_build_object(
      'handoffsRequested', (SELECT count(*)::int FROM period_handoffs),
      'resolvedConversations', (SELECT count FROM resolved),
      'unassignedConversations', (
        SELECT count(*)::int FROM conversations
        WHERE state IN ('handoff_pending', 'human_owned') AND assignee_account_id IS NULL
      ),
      'firstResponseSamples', (SELECT count(*)::int FROM first_replies WHERE first_reply_at IS NOT NULL)
    ),
    'medianFirstResponseSeconds', (
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_reply_at - requested_at)))
      FROM first_replies
      WHERE first_reply_at IS NOT NULL
    ),
    'handoffTrend', COALESCE((
      SELECT json_agg(json_build_object('date', date, 'count', count) ORDER BY date)
      FROM handoff_daily
    ), '[]'::json),
    'channels', COALESCE((
      SELECT json_agg(json_build_object('channel', channel, 'count', count) ORDER BY count DESC, channel)
      FROM channel_totals
    ), '[]'::json)
  ) AS analytics
`;

export function registerInboxAnalyticsRoutes(
  app: FastifyInstance,
  options: {
    pool: Pool;
    resolveScope(request: FastifyRequest): Promise<ActionScope>;
  },
): void {
  app.get(
    "/api/organizations/:organizationId/analytics/inbox",
    async (request) => {
      const scope = await options.resolveScope(request);
      const { days } = z
        .object({ days: z.enum(["7", "30"]).default("7") })
        .parse(request.query);
      await assertAgentsBillingFeature(
        options.pool,
        scope.organizationId,
        "agents.feature.analytics",
      );
      const result = await options.pool.query<{ analytics: unknown }>(
        inboxAnalyticsSql,
        [scope.organizationId, Number(days)],
      );
      return result.rows[0]?.analytics ?? {};
    },
  );
}
