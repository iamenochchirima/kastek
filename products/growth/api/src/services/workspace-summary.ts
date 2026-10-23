import type { CoreContext } from '../context.js';
import * as sql from './workspace-summary-sql.js';
import { listWhatsappConnections } from './whatsapp/connections.js';
type Row = Record<string, unknown>;
const count = (rows: Row[]) => BigInt(rows[0]!.count as string);
const buckets = (rows: Row[], key = 'status') =>
  new Map(rows.map((row) => [String(row[key]), BigInt(row.count as string)]));
export async function workspaceSummary(
  context: CoreContext,
  org: string,
  userId: string,
) {
  const pool = context.pool,
    now = new Date(),
    since30 = new Date(+now - 30 * 86_400_000),
    since24 = new Date(+now - 86_400_000),
    connections = await listWhatsappConnections(pool, org);
  const queries: [string, unknown[]][] = [
    [sql.SOCIAL_POST_COUNT_SQL, [org]],
    [sql.TEMPLATE_STATUS_SQL, [org]],
    [sql.CAMPAIGN_SUMMARY_SQL, [org]],
    [sql.ACTIVE_CAMPAIGNS_SQL, [org]],
    [sql.RECENT_CAMPAIGNS_SQL, [org]],
    [sql.TOTAL_CONTACTS_SQL, [org]],
    [sql.OPTED_IN_CONTACTS_SQL, [org]],
    [sql.EXCLUDED_CONTACTS_SQL, [org]],
    [sql.SEND_BREAKDOWN_SQL, [org, since30]],
    [sql.REVIEW_QUEUE_SQL, [org]],
    [sql.CAMPAIGN_SENDS_SQL, [org, since24]],
    [sql.UNREAD_CONVERSATIONS_SQL, [org]],
    [sql.SOCIAL_ATTENTION_SQL, [org]],
    [sql.CONNECTION_ATTENTION_SQL, [org]],
  ];
  const rows = await Promise.all(
    queries.map(
      async ([text, values]) => (await pool.query(text, values)).rows,
    ),
  );
  const aggregate = rows[2]![0]!,
    statusMap = buckets(rows[1]!),
    sendMap = buckets(rows[8]!),
    sentByConnection = buckets(rows[10]!, 'connection_id');
  const connectionViews = connections.map((connection) => {
    const sent = sentByConnection.get(connection.id) ?? 0n;
    return {
      id: connection.id,
      phoneDisplayNumber: connection.phoneDisplayNumber,
      phoneNumberId: connection.phoneNumberId,
      currentQualityRating: connection.currentQualityRating,
      dailyLimitEstimate: connection.dailyLimitEstimate,
      verified: connection.verified,
      createdAt: connection.createdAt,
      stats: {
        sentLast24h: sent,
        estimatedRemainingToday:
          connection.dailyLimitEstimate == null
            ? null
            : Math.max(
                (connection.dailyLimitEstimate -
                  Number(BigInt.asIntN(32, sent))) |
                  0,
                0,
              ),
      },
    };
  });
  return {
    summary: {
      agentCount: null,
      socialPostCount: count(rows[0]!),
      connections: connectionViews,
      templateStatusMap: Object.fromEntries(statusMap),
      campaignsAggregate: {
        totalCampaigns: BigInt(aggregate.total_campaigns),
        totalRecipients: BigInt(aggregate.total_recipients),
        deliveredCount: BigInt(aggregate.delivered_count),
        readCount: BigInt(aggregate.read_count),
        failedCount: BigInt(aggregate.failed_count),
        blockedCount: BigInt(aggregate.blocked_count),
      },
      activeCampaigns: count(rows[3]!),
      recentCampaigns: rows[4]!.map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        totalRecipients: r.total_recipients,
        deliveredCount: r.delivered_count,
        readCount: r.read_count,
        templateName: r.template_name,
        connectionLabel: r.connection_label,
      })),
      contactsAggregate: {
        total: count(rows[5]!),
        optedIn: count(rows[6]!),
        excluded: count(rows[7]!),
      },
      sendStatusMap: Object.fromEntries(sendMap),
      reviewQueue: rows[9]!.map((r) => ({
        id: r.id,
        templateName: r.template_name,
        status: r.status,
        body: r.body,
        connectionLabel: r.connection_label,
      })),
      attention: {
        unreadConversations: count(rows[11]!),
        agentAttention: null,
        campaignFailures:
          BigInt(aggregate.failed_count) + BigInt(aggregate.blocked_count),
        socialAttention: count(rows[12]!),
        connectionAttention: count(rows[13]!),
      },
    },
  };
}
