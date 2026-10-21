import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { PlatformError,requestDigest } from "../../contracts/contracts";
type Row=Record<string,any>;
export function channelSegments(text: string, maximum: number): string[] {
  const points = Array.from(text), result: string[] = [];
  for (let offset = 0; offset < points.length; offset += maximum) result.push(points.slice(offset, offset + maximum).join(""));
  return result;
}
/** Called in the canonical message transaction; the provider is never contacted here. */
export async function enqueueChannelMessage(db: PoolClient, conversation: Row, message: Row): Promise<void> {
  if (conversation.channel_kind === "website") return;
  const connection = (await db.query(`SELECT c.*,d.id deployment_id FROM agents_platform.channel_connections c
    JOIN agents_platform.channel_deployments d ON d.organization_id=c.organization_id AND d.connection_id=c.id
    WHERE d.id=$1 AND d.state='active' AND c.state='active' FOR SHARE OF c,d`, [conversation.channel_deployment_id])).rows[0];
  if (!connection) throw new PlatformError("CHANNEL_AUTHORITY_CHANGED",409,"Reconnect this channel before replying");
  // These are adapter-supported plain-text bounds, not model limits. Each segment has its own receipt.
  const maximum = connection.kind === "telegram" ? 4096 : connection.kind === "whatsapp" ? 4096 : 1000;
  const parts = channelSegments(message.body, maximum);
  for (const [segment, text] of parts.entries()) {
    const recipientId = ["facebook","instagram"].includes(connection.kind) && conversation.external_conversation_id.startsWith(`${connection.asset_id}:`)
      ? conversation.external_conversation_id.slice(connection.asset_id.length + 1) : conversation.external_conversation_id;
    const request = { assetId: connection.asset_id, recipientId, text };
    await db.query(`INSERT INTO agents_platform.channel_outbound(id,organization_id,connection_id,deployment_id,conversation_id,
      message_id,segment,ownership_generation,connection_revision,credential_revision,request,digest)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(message_id,segment) DO NOTHING`,
    [randomUUID(),conversation.organization_id,connection.id,connection.deployment_id,conversation.id,message.id,segment,
      conversation.ownership_generation,connection.revision,connection.credential_revision,request,requestDigest(request)]);
  }
}
