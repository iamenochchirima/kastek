import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ChannelAdapterError, channelWebhookEventSchema, type ChannelWebhookEvent, type ChannelProviderContext, type MessagingChannelKind } from "../../contracts/channel-adapters";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { messagingChannelAdapter } from "../../adapters/channels/providers";
import { transaction } from "../../infrastructure/database";
import { recordEvent } from "../../observability/event-store";
import type { InboxScope, InboxStore } from "../inbox/inbox-store";
import type { ChannelStore } from "./channel-store";

const rank: Record<string, number> = { accepted: 1, sent: 2, delivered: 3, read: 4 };
type Row = Record<string, any>;
export interface ChannelDeliveryPorts {
  context(connection: Row, credentials: Record<string,string>, beforeAttempt: () => Promise<void>): ChannelProviderContext;
  assertPolicy(connection: Row, message: Row, request: Row): Promise<void>;
}
export class ChannelDelivery {
  constructor(readonly pool: Pool, readonly channels: ChannelStore, readonly inbox: InboxStore, readonly ports: ChannelDeliveryPorts) {}
  /** Only verified/normalized provider events reach this port. Receipt and processing intent commit before webhook ACK. */
  async persist(kind: MessagingChannelKind, raw: ChannelWebhookEvent[]): Promise<number> {
    if (raw.length > 100) throw new PlatformError("CHANNEL_WEBHOOK_LIMIT",413,"Too many channel events");
    const events = raw.map(event => channelWebhookEventSchema.parse(event));
    return transaction(this.pool, async db => {
      let count = 0;
      for (const event of events) {
        const bindings = (await db.query(`SELECT c.id connection_id,c.organization_id,d.id deployment_id FROM agents_platform.channel_connections c
          JOIN agents_platform.channel_deployments d ON d.connection_id=c.id AND d.organization_id=c.organization_id
          WHERE c.kind=$1 AND c.asset_id=$2 AND c.state='active' AND d.state='active' FOR SHARE OF c,d`,[kind,event.assetId])).rows;
        if (bindings.length !== 1) throw new PlatformError("CHANNEL_DESTINATION_UNAVAILABLE",409,"Channel destination is unavailable");
        const binding = bindings[0], digest = requestDigest(event);
        const inserted = await db.query(`INSERT INTO agents_platform.channel_ingress(id,organization_id,connection_id,deployment_id,event_id,digest,event)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(connection_id,event_id) DO NOTHING RETURNING id`,
        [randomUUID(),binding.organization_id,binding.connection_id,binding.deployment_id,event.eventId,digest,event]);
        if (!inserted.rowCount) {
          const existing = (await db.query("SELECT digest FROM agents_platform.channel_ingress WHERE connection_id=$1 AND event_id=$2",[binding.connection_id,event.eventId])).rows[0];
          if (existing.digest !== digest) throw new PlatformError("CHANNEL_EVENT_CONFLICT",409,"Conflicting provider event identity");
        } else count++;
      }
      return count;
    });
  }
  private async claimIngress(): Promise<Row | null> {
    return transaction(this.pool, async db => {
      const row = (await db.query(`SELECT * FROM agents_platform.channel_ingress WHERE
        (state='pending' AND available_at<=now()) OR (state='processing' AND lease_until<now())
        ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return null;
      return (await db.query(`UPDATE agents_platform.channel_ingress SET state='processing',attempts=attempts+1,
        claim_id=$2,lease_until=now()+interval '60 seconds' WHERE id=$1 RETURNING *`,[row.id,randomUUID()])).rows[0];
    });
  }
  private async processIngress(row: Row): Promise<void> {
    const event = channelWebhookEventSchema.parse(row.event);
    let messageId: string | null = null;
    if (event.kind === "receipt") await this.receipt(row.connection_id,event);
    else if (event.kind === "message" && !event.echo) {
      const body = event.text?.trim() || (event.attachments.length ? "[Attachment received. Staff assistance required.]" : "[Unsupported message. Staff assistance required.]");
      const result = await this.inbox.ingressChannel({deploymentId:row.deployment_id,externalConversationId:event.externalConversationId,
        senderId:event.senderId,requestKey:row.id,body,requireHandoff: !event.text?.trim()});
      messageId = result.message.id;
      await this.pool.query(`INSERT INTO agents_platform.channel_message_facts(message_id,connection_id,provider_message_id,
        provider_occurred_at,reply_to_provider_message_id,attachments) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(message_id) DO NOTHING`,
      [messageId,row.connection_id,event.providerMessageId,event.occurredAt,event.replyToProviderMessageId ?? null,JSON.stringify(event.attachments)]);
    }
    // Unsupported callback payloads remain evidence, never approval or executable tool authority.
    await this.pool.query(`UPDATE agents_platform.channel_ingress SET state='completed',completed_at=now(),message_id=$3,
      reason=$4,lease_until=NULL WHERE id=$1 AND claim_id=$2 AND state='processing'`,
    [row.id,row.claim_id,messageId,event.kind === "interaction" ? "unsupported_interaction" : event.echo ? "echo_suppressed" : null]);
  }
  async receipt(connectionId: string, event: ChannelWebhookEvent): Promise<void> {
    const status = event.status;
    if (!status) return;
    let watermark: Date | null = null;
    if (event.receiptWatermark && /^\d{10,16}$/.test(event.receiptWatermark)) {
      const numeric = Number(event.receiptWatermark); const value = new Date(event.receiptWatermark.length <= 10 ? numeric * 1000 : numeric);
      if (Number.isFinite(value.getTime())) watermark = value;
    }
    await transaction(this.pool,async db => {
      await db.query(`INSERT INTO agents_platform.channel_receipts(connection_id,event_id,provider_message_id,external_conversation_id,status,
        provider_occurred_at,watermark,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [connectionId,event.eventId,event.providerMessageId,event.externalConversationId,status,event.occurredAt,watermark,event.errorCode ?? null]);
      const rows = (await db.query(`SELECT o.* FROM agents_platform.channel_outbound o JOIN agents_platform.customer_conversations c ON c.id=o.conversation_id
        WHERE o.connection_id=$1 AND (($2::text IS NOT NULL AND o.provider_message_id=$2) OR ($3::timestamptz IS NOT NULL
        AND c.external_conversation_id=$4 AND o.updated_at<=$3 AND o.provider_message_id IS NOT NULL)) FOR UPDATE OF o`,
      [connectionId,event.providerMessageId,watermark,event.externalConversationId])).rows;
      for (const row of rows) if ((rank[status] ?? 0) > (rank[row.state] ?? 0) || status === "failed" && !["delivered","read"].includes(row.state)) {
        await db.query("UPDATE agents_platform.channel_outbound SET state=$2,reason=$3,updated_at=now() WHERE id=$1",[row.id,status,event.errorCode ?? null]);
      }
    });
  }
  private async claimOutbound(): Promise<Row | null> {
    return transaction(this.pool, async db => {
      // A process that lost its claim may already have sent. Expiry preserves uncertainty; it never queues another POST.
      await db.query("UPDATE agents_platform.channel_outbound SET state='unknown',reason='send_acknowledgement_lost',updated_at=now() WHERE state='sending' AND lease_until<now()");
      const row = (await db.query(`SELECT o.* FROM agents_platform.channel_outbound o WHERE o.state='pending' AND o.available_at<=now()
        AND NOT EXISTS(SELECT 1 FROM agents_platform.channel_outbound p JOIN agents_platform.customer_messages pm ON pm.id=p.message_id
          JOIN agents_platform.customer_messages om ON om.id=o.message_id WHERE p.conversation_id=o.conversation_id
          AND (pm.sequence,p.segment)<(om.sequence,o.segment) AND p.state NOT IN ('accepted','sent','delivered','read','suppressed'))
        AND NOT EXISTS(SELECT 1 FROM agents_platform.channel_outbound busy WHERE busy.connection_id=o.connection_id AND busy.state='sending')
        ORDER BY o.available_at,o.id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return null;
      if (!(await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked",[`channel-send:${row.connection_id}`])).rows[0].locked) return null;
      if ((await db.query("SELECT 1 FROM agents_platform.channel_outbound WHERE connection_id=$1 AND state='sending'",[row.connection_id])).rowCount) return null;
      return (await db.query(`UPDATE agents_platform.channel_outbound SET state='sending',attempts=attempts+1,claim_id=$2,
        lease_until=now()+interval '45 seconds',updated_at=now() WHERE id=$1 RETURNING *`,[row.id,randomUUID()])).rows[0];
    });
  }
  private async authority(row: Row): Promise<{connection: Row; message: Row}> {
    return transaction(this.pool, async db => {
      const result = (await db.query(`SELECT row_to_json(c) connection,row_to_json(m) message FROM agents_platform.channel_outbound o
        JOIN agents_platform.customer_conversations p ON p.id=o.conversation_id JOIN agents_platform.customer_messages m ON m.id=o.message_id
        JOIN agents_platform.channel_deployments d ON d.id=o.deployment_id JOIN agents_platform.channel_connections c ON c.id=o.connection_id
        WHERE o.id=$1 AND o.claim_id=$2 AND o.state='sending' AND o.lease_until>now() AND d.state='active' AND c.state='active'
        AND p.channel_deployment_id=d.id AND p.ownership_generation=o.ownership_generation
        AND c.revision=o.connection_revision AND c.credential_revision=o.credential_revision
        AND ((m.author_kind='assistant' AND p.state='automation_active') OR (m.author_kind='human' AND p.state='human_owned'
          AND p.assignee_account_id=m.author_account_id AND EXISTS(SELECT 1 FROM agents_platform.memberships mem
            WHERE mem.organization_id=p.organization_id AND mem.account_id=m.author_account_id AND mem.revoked_at IS NULL)))
        FOR SHARE OF o,p,d,c,m`,[row.id,row.claim_id])).rows[0];
      if (!result) throw new PlatformError("CHANNEL_AUTHORITY_CHANGED",403,"Message authority changed");
      return result;
    });
  }
  private async dispatch(row: Row): Promise<void> {
    let physical = false;
    try {
      const {connection,message} = await this.authority(row);
      await this.ports.assertPolicy(connection,message,row.request);
      const credentials = await this.channels.resolveCredential({organizationId:row.organization_id,connectionId:row.connection_id,
        expectedRevision:row.connection_revision,credentialRevision:row.credential_revision});
      const context = this.ports.context(connection,credentials,async () => {
        const current = await this.authority(row); await this.ports.assertPolicy(current.connection,current.message,row.request); physical = true;
      });
      const result = await messagingChannelAdapter(connection.kind).send(row.request,context);
      await this.finish(row,result.status,result.providerMessageId,result.status === "unknown" ? "provider_acknowledgement_unknown" : null);
      // Late receipts may precede the send response; replay facts after attaching the returned provider ID.
      if (result.providerMessageId) {
        const receipts = (await this.pool.query("SELECT * FROM agents_platform.channel_receipts WHERE connection_id=$1 AND provider_message_id=$2 ORDER BY created_at",[row.connection_id,result.providerMessageId])).rows;
        for (const receipt of receipts) await this.receipt(row.connection_id,{...channelWebhookEventSchema.parse({kind:"receipt",assetId:connection.asset_id,eventId:receipt.event_id,
          externalConversationId:receipt.external_conversation_id,senderId:receipt.external_conversation_id,providerMessageId:result.providerMessageId,
          occurredAt:receipt.provider_occurred_at?.toISOString() ?? null,status:receipt.status})});
      }
    } catch (error) {
      const known = error instanceof ChannelAdapterError && error.outcome === "rejected";
      const code = error instanceof PlatformError || error instanceof ChannelAdapterError ? error.code : "CHANNEL_SEND_UNAVAILABLE";
      if (known && error.status === 429 && error.retryAfterMs !== undefined && row.attempts < 5) {
        await this.pool.query(`UPDATE agents_platform.channel_outbound SET state='pending',reason=$3,available_at=now()+($4*interval '1 millisecond'),
          lease_until=NULL,updated_at=now() WHERE id=$1 AND claim_id=$2 AND state='sending'`,[row.id,row.claim_id,code,Math.max(1000,Math.min(error.retryAfterMs,86400000))]);
      } else await this.finish(row,known ? "failed" : !physical && error instanceof PlatformError ? "suppressed" : "unknown",null,code);
    }
  }
  private async finish(row: Row, state: string, providerId: string | null, reason: string | null) {
    await transaction(this.pool,async db => {
      const changed = await db.query(`UPDATE agents_platform.channel_outbound SET state=$3,provider_message_id=$4,reason=$5,lease_until=NULL,updated_at=now()
        WHERE id=$1 AND claim_id=$2 AND state='sending' RETURNING id`,[row.id,row.claim_id,state,providerId,reason]);
      if (changed.rowCount) {
        const message = (await db.query("SELECT task_id FROM agents_platform.customer_messages WHERE id=$1",[row.message_id])).rows[0];
        if (message?.task_id) await recordEvent(db,message.task_id,`channel:send:${row.id}:${row.attempts}`,"channel.delivery",{outcome:state === "unknown" ? "uncertain" : state === "suppressed" ? "suppressed" : state === "failed" ? "failed" : "completed",count:1});
      }
    });
  }
  /** Bounded maintenance invoked by the existing worker lifecycle, never a provider-specific scheduler. */
  async drain(limit = 8): Promise<void> {
    for (let index=0;index<Math.min(limit,32);index++) {
      const ingress = await this.claimIngress();
      if (ingress) try { await this.processIngress(ingress); } catch (error) {
        const reason = error instanceof PlatformError ? error.code : "CHANNEL_INGRESS_UNAVAILABLE";
        await this.pool.query(`UPDATE agents_platform.channel_ingress SET state=$3,reason=$4,available_at=now()+($5*interval '1 second'),lease_until=NULL
          WHERE id=$1 AND claim_id=$2 AND state='processing'`,[ingress.id,ingress.claim_id,ingress.attempts>=5 ? "quarantined" : "pending",reason,Math.min(300,2**ingress.attempts)]);
      }
      const outbound = await this.claimOutbound(); if (outbound) await this.dispatch(outbound);
      if (!ingress && !outbound) break;
    }
  }
  async readDeliveries(scope: InboxScope, conversationId: string) {
    await this.inbox.readStaff(scope,conversationId,"0",1);
    return (await this.pool.query(`SELECT id,message_id,segment,state,reason,attempts,updated_at FROM agents_platform.channel_outbound
      WHERE organization_id=$1 AND conversation_id=$2 ORDER BY created_at,segment LIMIT 200`,[scope.organizationId,conversationId])).rows;
  }
}
