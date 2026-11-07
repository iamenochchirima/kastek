import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import type { ActionScope } from "../../contracts/connections";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";

export function registerOverviewRoutes(app: FastifyInstance, options: {
  pool: Pool;
  resolveScope(request: FastifyRequest): Promise<ActionScope>;
}) {
  app.get("/api/organizations/:organizationId/overview", async request => {
    const scope = await options.resolveScope(request);
    const { days } = z.object({ days: z.enum(["7", "30"]).default("7") }).parse(request.query);
    return transaction(options.pool, async db => {
      await requireActionMember(db, scope);
      const result = await db.query(`
        WITH bounds AS (
          SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') - ($2::int - 1) * interval '1 day') AT TIME ZONE 'UTC' AS start_at,
                 now() AS end_at
        ), conversations AS (
          SELECT c.id, c.agent_id, a.name AS agent_name, c.channel_kind, c.state, c.created_at, c.updated_at,
            EXISTS(SELECT 1 FROM agents_platform.human_assistance_requests h WHERE h.conversation_id=c.id AND h.status='requested') AS human_requested
          FROM agents_platform.customer_conversations c
          JOIN agents_platform.agents a ON a.id = c.agent_id AND a.organization_id = c.organization_id
          WHERE c.organization_id = $1
            AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id = c.session_id)
            AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id = c.channel_deployment_id)
        ), in_period AS (
          SELECT c.* FROM conversations c CROSS JOIN bounds b WHERE c.created_at >= b.start_at AND c.created_at <= b.end_at
        ), recent AS (
          SELECT * FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 5
        ), attention AS (
          SELECT * FROM conversations WHERE state = 'handoff_pending' OR human_requested ORDER BY updated_at DESC, id DESC LIMIT 5
        ), daily AS (
          SELECT to_char(day, 'YYYY-MM-DD') AS date,
            (SELECT count(*)::int FROM in_period c WHERE (c.created_at AT TIME ZONE 'UTC')::date = day::date) AS count
          FROM generate_series((SELECT start_at AT TIME ZONE 'UTC' FROM bounds),
            date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day') AS day
        ), channel_totals AS (
          SELECT channel_kind AS channel, count(*)::int AS count FROM in_period GROUP BY channel_kind
        )
        SELECT json_build_object(
          'period', json_build_object('days', $2::int),
          'counts', json_build_object(
            'conversations', (SELECT count(*)::int FROM in_period),
            'needsAttention', (SELECT count(*)::int FROM conversations WHERE state = 'handoff_pending' OR human_requested),
            'enquiries', (SELECT count(*)::int FROM agents_platform.customer_record_enquiries e CROSS JOIN bounds b
              WHERE e.organization_id = $1 AND e.created_at >= b.start_at AND e.created_at <= b.end_at),
            'activeAgents', (SELECT count(DISTINCT agent_id)::int FROM in_period)
          ),
          'conversationActivity', COALESCE((SELECT json_agg(json_build_object('date', date, 'count', count) ORDER BY date) FROM daily), '[]'::json),
          'needsAttention', COALESCE((SELECT json_agg(json_build_object('id', id, 'agentName', agent_name, 'channel', channel_kind, 'updatedAt', updated_at) ORDER BY updated_at DESC, id DESC) FROM attention), '[]'::json),
          'recentActivity', COALESCE((SELECT json_agg(json_build_object('id', id, 'agentName', agent_name, 'channel', channel_kind, 'state', state, 'updatedAt', updated_at) ORDER BY updated_at DESC, id DESC) FROM recent), '[]'::json),
          'channels', COALESCE((SELECT json_agg(json_build_object('channel', channel, 'count', count) ORDER BY count DESC, channel) FROM channel_totals), '[]'::json)
        ) AS overview`, [scope.organizationId, Number(days)]);
      return result.rows[0].overview;
    });
  });

  app.get("/api/organizations/:organizationId/agents/:agentId/overview", async request => {
    const scope = await options.resolveScope(request);
    const { days } = z.object({ days: z.enum(["7", "30"]).default("7") }).parse(request.query);
    const agentId = z.uuid().parse((request.params as Record<string, string>).agentId);
    return transaction(options.pool, async db => {
      await requireActionMember(db, scope);
      if (!(await db.query("SELECT 1 FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL", [scope.organizationId, agentId])).rowCount)
        throw new PlatformError("NOT_FOUND", 404, "Agent not found");
      const result = await db.query(`
        WITH bounds AS (
          SELECT (date_trunc('day', now() AT TIME ZONE 'UTC') - ($2::int - 1) * interval '1 day') AT TIME ZONE 'UTC' AS start_at,
                 now() AS end_at
        ), conversations AS (
          SELECT c.id, c.agent_id, a.name AS agent_name, c.channel_kind, c.state, c.created_at, c.updated_at,
            EXISTS(SELECT 1 FROM agents_platform.human_assistance_requests h WHERE h.conversation_id=c.id AND h.status='requested') AS human_requested
          FROM agents_platform.customer_conversations c
          JOIN agents_platform.agents a ON a.id = c.agent_id AND a.organization_id = c.organization_id
          WHERE c.organization_id = $1 AND c.agent_id = $3
            AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id = c.session_id)
            AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id = c.channel_deployment_id)
        ), in_period AS (
          SELECT c.* FROM conversations c CROSS JOIN bounds b WHERE c.created_at >= b.start_at AND c.created_at <= b.end_at
        ), recent AS (
          SELECT * FROM conversations ORDER BY updated_at DESC, id DESC LIMIT 5
        ), attention AS (
          SELECT * FROM conversations WHERE state = 'handoff_pending' OR human_requested ORDER BY updated_at DESC, id DESC LIMIT 5
        ), daily AS (
          SELECT to_char(day, 'YYYY-MM-DD') AS date,
            (SELECT count(*)::int FROM in_period c WHERE (c.created_at AT TIME ZONE 'UTC')::date = day::date) AS count
          FROM generate_series((SELECT start_at AT TIME ZONE 'UTC' FROM bounds),
            date_trunc('day', now() AT TIME ZONE 'UTC'), interval '1 day') AS day
        ), channel_totals AS (
          SELECT channel_kind AS channel, count(*)::int AS count FROM in_period GROUP BY channel_kind
        ), message_totals AS (
          SELECT count(*)::int AS count FROM agents_platform.customer_messages m
          JOIN conversations c ON c.id = m.conversation_id CROSS JOIN bounds b
          WHERE m.created_at >= b.start_at AND m.created_at <= b.end_at
        ), latest_version AS (
          SELECT id FROM agents_platform.agent_versions WHERE organization_id = $1 AND agent_id = $3 ORDER BY number DESC LIMIT 1
        ), knowledge AS (
          SELECT count(DISTINCT vs.source_id)::int AS sources, count(sc.id)::int AS chunks
          FROM agents_platform.version_sources vs
          LEFT JOIN agents_platform.source_chunks sc ON sc.organization_id = vs.organization_id AND sc.revision_id = vs.revision_id
          WHERE vs.organization_id = $1 AND vs.version_id = (SELECT id FROM latest_version)
        )
        SELECT json_build_object(
          'period', json_build_object('days', $2::int),
          'counts', json_build_object(
            'conversations', (SELECT count(*)::int FROM in_period),
            'messages', (SELECT count FROM message_totals),
            'needsAttention', (SELECT count(*)::int FROM conversations WHERE state = 'handoff_pending' OR human_requested),
            'activeChannels', (SELECT count(DISTINCT channel_kind)::int FROM in_period),
            'knowledgeSources', COALESCE((SELECT sources FROM knowledge), 0),
            'knowledgeChunks', COALESCE((SELECT chunks FROM knowledge), 0)
          ),
          'conversationActivity', COALESCE((SELECT json_agg(json_build_object('date', date, 'count', count) ORDER BY date) FROM daily), '[]'::json),
          'needsAttention', COALESCE((SELECT json_agg(json_build_object('id', id, 'agentName', agent_name, 'channel', channel_kind, 'updatedAt', updated_at) ORDER BY updated_at DESC, id DESC) FROM attention), '[]'::json),
          'recentActivity', COALESCE((SELECT json_agg(json_build_object('id', id, 'agentName', agent_name, 'channel', channel_kind, 'state', state, 'updatedAt', updated_at) ORDER BY updated_at DESC, id DESC) FROM recent), '[]'::json),
          'channels', COALESCE((SELECT json_agg(json_build_object('channel', channel, 'count', count) ORDER BY count DESC, channel) FROM channel_totals), '[]'::json)
        ) AS overview`, [scope.organizationId, Number(days), agentId]);
      return result.rows[0].overview;
    });
  });
}
