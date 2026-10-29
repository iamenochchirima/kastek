import {assertEnquiryReviewPrompt,enquiryReviewDecision} from "./channel-enquiry-reviews";
import { randomUUID } from "node:crypto";
import { HANDOFF_RECEIPT } from "../inbox/handoff-receipt";
import type { Pool, PoolClient } from "pg";
import { ChannelAdapterError, channelWebhookEventSchema, type ChannelWebhookEvent, type ChannelProviderContext, type MessagingChannelKind, type ChannelSendRequest } from "../../contracts/channel-adapters";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { messagingChannelAdapter } from "../../adapters/channels/providers";
import { transaction } from "../../infrastructure/database";
import { recordEvent } from "../../observability/event-store";
import type { InboxScope, InboxStore } from "../inbox/inbox-store";
import type { ChannelStore } from "./channel-store";
import {assertChannelToolReviewPrompt,channelToolReviewDecision} from "./channel-tool-reviews";

const rank: Record<string, number> = { accepted: 1, sent: 2, delivered: 3, read: 4 };
type Row = Record<string, any>;
export interface ChannelDeliveryPorts {
  context(connection: Row, credentials: Record<string,string>, beforeAttempt: () => Promise<void>): ChannelProviderContext;
  assertPolicy(connection: Row, message: Row, request: ChannelSendRequest & {templateAuthorization?:unknown;mediaAuthorization?:unknown}): Promise<void>;
  acknowledgeInteraction?(connectionId:string,event:ChannelWebhookEvent,outcome?:"confirmed"|"rejected"):Promise<void>;
  handleInteraction?(connectionId:string,deploymentId:string,event:ChannelWebhookEvent):Promise<"confirmed"|"rejected"|null>;
}
export class ChannelDelivery {
  constructor(readonly pool: Pool, readonly channels: ChannelStore, readonly inbox: InboxStore, readonly ports: ChannelDeliveryPorts) {}
  /** Only verified/normalized provider events reach this port. Receipt and processing intent commit before webhook ACK. */
  async persist(kind: MessagingChannelKind, raw: ChannelWebhookEvent[], verifiedMode?:string,verifiedProfileDigest?:string,fixtureTrialId?:string): Promise<number> {
    if (raw.length > 100) throw new PlatformError("CHANNEL_WEBHOOK_LIMIT",413,"Too many channel events");
    const events = raw.map(event => channelWebhookEventSchema.parse(event));
    return transaction(this.pool, async db => {
      let count = 0;
      for (const event of events) {
        const bindings = (await db.query(`SELECT c.id connection_id,c.organization_id,d.id deployment_id FROM agents_platform.channel_connections c
          JOIN agents_platform.channel_deployments d ON d.connection_id=c.id AND d.organization_id=c.organization_id
          WHERE c.kind=$1 AND c.asset_id=$2 AND c.state='active' AND d.state='active'
            AND ($3::text IS NULL OR c.mode=$3) AND ($4::text IS NULL OR c.metadata->>'setupProfileDigest'=$4)
            AND ((c.metadata->>'evaluationTrialId' IS NULL AND $5::uuid IS NULL) OR
              (c.metadata->>'evaluationTrialId'=$5::text AND EXISTS(SELECT 1 FROM agents_platform.evaluation_trials e
                JOIN agents_platform.memberships m ON m.organization_id=e.organization_id AND m.account_id=e.account_id AND m.revoked_at IS NULL
                WHERE e.id=$5 AND e.organization_id=c.organization_id AND e.agent_id=d.agent_id AND e.version_id=d.version_id AND e.state='active' AND e.expires_at>now())))
          FOR SHARE OF c,d`,[kind,event.assetId,verifiedMode??null,verifiedProfileDigest??null,fixtureTrialId??null])).rows;
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
      const row = (await db.query(`SELECT i.* FROM agents_platform.channel_ingress i WHERE
        ((i.state='pending' AND i.available_at<=now()) OR (i.state='processing' AND i.lease_until<now()))
        AND NOT EXISTS(SELECT 1 FROM agents_platform.channel_ingress prior WHERE prior.connection_id=i.connection_id
          AND prior.event->>'externalConversationId'=i.event->>'externalConversationId' AND prior.sequence<i.sequence AND prior.state IN ('pending','processing'))
        ORDER BY i.sequence LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if (!row) return null;
      return (await db.query(`UPDATE agents_platform.channel_ingress SET state='processing',attempts=attempts+1,
        claim_id=$2,lease_until=now()+interval '60 seconds' WHERE id=$1 RETURNING *`,[row.id,randomUUID()])).rows[0];
    });
  }
  private async processIngress(row: Row): Promise<void> {
    const event = channelWebhookEventSchema.parse(row.event);
    let messageId: string | null = null;
    const recognized=channelToolReviewDecision(event)??enquiryReviewDecision(event);
    const interaction=recognized?(await this.ports.handleInteraction?.(row.connection_id,row.deployment_id,event)??"rejected"):null;
    if(interaction){if(event.callbackQueryId)await this.ports.acknowledgeInteraction?.(row.connection_id,event,interaction);}
    else if (event.kind === "receipt") await this.receipt(row.connection_id,event);
    else if(event.echo&&event.providerMessageId)await this.replayReceipts(row.connection_id,event.assetId,event.externalConversationId,event.providerMessageId);
    else if(event.kind==="interaction"&&event.callbackQueryId) await this.ports.acknowledgeInteraction?.(row.connection_id,event);
    else if (event.kind === "message" && !event.echo) {
      const body = event.text?.trim() || (event.attachments.length ? "[Attachment received. Staff assistance required.]" : "[Unsupported message. Staff assistance required.]");
      const result = await this.inbox.ingressChannel({deploymentId:row.deployment_id,externalConversationId:event.externalConversationId,
        senderId:event.senderId,requestKey:requestDigest({connectionId:row.connection_id,thread:event.externalConversationId,
          providerMessageId:event.providerMessageId??event.eventId}),body,requireHandoff: !event.text?.trim()});
      messageId = result.message.id;
      await this.pool.query(`INSERT INTO agents_platform.channel_message_facts(message_id,connection_id,provider_message_id,
        provider_occurred_at,reply_to_provider_message_id,attachments,external_conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(message_id) DO NOTHING`,
      [messageId,row.connection_id,event.providerMessageId,event.occurredAt,event.replyToProviderMessageId ?? null,JSON.stringify(event.attachments),event.externalConversationId]);
    }
    // Unsupported callback payloads remain evidence, never approval or executable tool authority.
    await this.pool.query(`UPDATE agents_platform.channel_ingress SET state='completed',completed_at=now(),message_id=$3,
      reason=$4,lease_until=NULL WHERE id=$1 AND claim_id=$2 AND state='processing'`,
    [row.id,row.claim_id,messageId,interaction?`contact_review_${interaction}`:event.kind === "interaction" ? "unsupported_interaction" : event.echo ? "echo_suppressed" : null]);
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
        WHERE o.connection_id=$1 AND c.external_conversation_id=$4 AND (($2::text IS NOT NULL AND o.provider_message_id=$2) OR ($3::timestamptz IS NOT NULL
        AND o.provider_message_id IS NOT NULL AND EXISTS(SELECT 1 FROM agents_platform.channel_ingress native
          WHERE native.connection_id=o.connection_id AND native.event->>'providerMessageId'=o.provider_message_id
            AND native.event->>'echo'='true' AND (native.event->>'occurredAt')::timestamptz<=$3))) FOR UPDATE OF o`,
      [connectionId,event.providerMessageId,watermark,event.externalConversationId])).rows;
      for (const row of rows) if ((rank[status] ?? 0) > (rank[row.state] ?? 0) && (row.state!=="failed"||["delivered","read"].includes(status)) || status === "failed" && !["delivered","read"].includes(row.state)) {
        await db.query("UPDATE agents_platform.channel_outbound SET state=$2,reason=$3,updated_at=now() WHERE id=$1",[row.id,status,event.errorCode ?? null]);
        if(status==="failed")await db.query("UPDATE agents_platform.channel_outbound SET state='suppressed',reason='earlier_segment_failed',updated_at=now() WHERE message_id=$1 AND segment>$2 AND state='pending'",[row.message_id,row.segment]);
      }
    });
  }
  private async claimOutbound(): Promise<Row | null> {
    return transaction(this.pool, async db => {
      // A process that lost its claim may already have sent. Expiry preserves uncertainty; it never queues another POST.
      await db.query("UPDATE agents_platform.channel_outbound SET state='unknown',reason='send_acknowledgement_lost',updated_at=now() WHERE state='sending' AND lease_until<now()");
      const row = (await db.query(`SELECT o.* FROM agents_platform.channel_outbound o WHERE o.state='pending' AND o.available_at<=now()
        AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_commands receipt
          LEFT JOIN agents_platform.channel_message_facts facts ON facts.message_id=receipt.command_id
          WHERE receipt.conversation_id=o.conversation_id AND receipt.action='message_handoff'
            AND receipt.result->>'handoffReceiptId'=o.message_id::text AND facts.message_id IS NULL)
        AND NOT EXISTS(SELECT 1 FROM agents_platform.channel_send_limits quota WHERE quota.connection_id=o.connection_id AND quota.next_send_at>now())
        AND NOT EXISTS(SELECT 1 FROM agents_platform.channel_outbound p JOIN agents_platform.customer_messages pm ON pm.id=p.message_id
          JOIN agents_platform.customer_messages om ON om.id=o.message_id WHERE p.conversation_id=o.conversation_id
          AND (pm.sequence,p.segment)<(om.sequence,o.segment) AND p.state NOT IN ('accepted','sent','delivered','read','suppressed')
          AND NOT(p.state='failed' AND p.message_id<>o.message_id)
          AND NOT(p.state='unknown' AND EXISTS(SELECT 1 FROM agents_platform.channel_delivery_recovery recovery WHERE recovery.delivery_id=p.id)))
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
      const pendingReceipt=Boolean((await db.query(`SELECT 1 FROM agents_platform.channel_outbound o JOIN agents_platform.customer_messages m ON m.id=o.message_id
        WHERE o.id=$1 AND m.task_id IS NOT NULL AND m.request_key='handoff-receipt:'||m.task_id::text`,[row.id])).rowCount);
      // The new table is only referenced for versioned receipts; legacy installations need no migration to deliver v1 messages.
      const receiptCondition=pendingReceipt ? `OR (p.state='handoff_pending' AND m.task_id IS NOT NULL AND m.ownership_generation=o.ownership_generation
        AND m.request_key='handoff-receipt:'||m.task_id::text AND EXISTS(SELECT 1 FROM agents_platform.pending_handoff_receipts receipt
          WHERE receipt.task_id=m.task_id AND receipt.conversation_id=p.id AND receipt.message_id=m.id
            AND receipt.ownership_generation=o.ownership_generation AND receipt.outcome IN ('model','fallback')))` : "";
      const result = (await db.query(`SELECT row_to_json(c) connection,row_to_json(m) message FROM agents_platform.channel_outbound o
        JOIN agents_platform.customer_conversations p ON p.id=o.conversation_id JOIN agents_platform.customer_messages m ON m.id=o.message_id
        JOIN agents_platform.channel_deployments d ON d.id=o.deployment_id JOIN agents_platform.channel_connections c ON c.id=o.connection_id
        WHERE o.id=$1 AND o.claim_id=$2 AND o.state='sending' AND o.lease_until>now() AND d.state='active' AND c.state='active'
        AND p.channel_deployment_id=d.id AND p.ownership_generation=o.ownership_generation
        AND c.revision=o.connection_revision AND c.credential_revision=o.credential_revision
        AND ((m.author_kind='assistant' AND (p.state='automation_active' OR (p.state='handoff_pending' AND m.body=$3 AND m.ownership_generation=o.ownership_generation
          AND m.request_key='handoff:'||m.task_id::text AND EXISTS(SELECT 1 FROM agents_platform.customer_commands receipt
            WHERE receipt.conversation_id=p.id AND receipt.command_id=m.task_id AND receipt.action='request_handoff'
              AND receipt.result->>'handoffReceiptId'=m.id::text AND receipt.result->>'ownership_generation'=o.ownership_generation::text))
          ${receiptCondition} OR (p.state='handoff_pending' AND m.task_id IS NULL AND m.body=$3 AND m.ownership_generation=o.ownership_generation
            AND EXISTS(SELECT 1 FROM agents_platform.customer_commands receipt JOIN agents_platform.support_waiting waiting
              ON waiting.task_id=receipt.command_id AND waiting.conversation_id=receipt.conversation_id AND waiting.source_message_id=receipt.command_id
              JOIN agents_platform.customer_messages origin ON origin.id=waiting.source_message_id AND origin.conversation_id=p.id AND origin.author_kind='visitor'
              WHERE receipt.conversation_id=p.id AND receipt.action='message_handoff' AND receipt.result->>'handoffReceiptId'=m.id::text
                AND receipt.result->>'ownership_generation'=o.ownership_generation::text AND m.request_key='handoff-message:'||origin.id::text)) OR
          (p.state IN ('handoff_pending','human_owned') AND m.task_id IS NULL AND m.ownership_generation=o.ownership_generation
            AND EXISTS(SELECT 1 FROM agents_platform.support_waiting_notices notice JOIN agents_platform.support_waiting waiting ON waiting.task_id=notice.task_id
              WHERE notice.message_id=m.id AND notice.state='published' AND notice.body=m.body AND notice.ownership_generation=o.ownership_generation
                AND waiting.conversation_id=p.id
                AND EXISTS(SELECT 1 FROM agents_platform.agents a JOIN agents_platform.agent_versions v
                  ON v.agent_id=a.id AND v.organization_id=a.organization_id AND v.id=d.version_id
                  WHERE a.id=p.agent_id AND a.organization_id=p.organization_id AND a.deleted_at IS NULL
                    AND (waiting.source_message_id IS NOT NULL OR (v.configuration->'tools') ? 'channel.request_handoff')
                  FOR SHARE OF a,v)
                AND NOT EXISTS (SELECT 1 FROM agents_platform.customer_messages reply
                  WHERE reply.conversation_id=p.id AND reply.author_kind='human' AND reply.ownership_generation>=waiting.ownership_generation))))) OR (m.author_kind='human' AND p.state='human_owned'
          AND p.assignee_account_id=m.author_account_id AND EXISTS(SELECT 1 FROM agents_platform.memberships mem
            WHERE mem.organization_id=p.organization_id AND mem.account_id=m.author_account_id AND mem.revoked_at IS NULL)))
        FOR SHARE OF o,p,d,c,m`,[row.id,row.claim_id,HANDOFF_RECEIPT])).rows[0];
      if (!result) throw new PlatformError("CHANNEL_AUTHORITY_CHANGED",403,"Message authority changed");
      if(pendingReceipt) await this.inbox.assertPendingReceiptDelivery(db,result.message);
      if(row.request.enquiryReview)await assertEnquiryReviewPrompt(db,row.request,row.conversation_id);
      if(row.request.toolReview)await assertChannelToolReviewPrompt(db,row.request,row.conversation_id);
      return result;
    });
  }
  private async dispatch(row: Row): Promise<void> {
    let physical = false;
    let fenceFailure:PlatformError|undefined;
    try {
      if(requestDigest(row.request)!==row.digest)throw new PlatformError("CHANNEL_DELIVERY_INTEGRITY",409,"The saved delivery request changed");
      const {connection,message} = await this.authority(row);
      await this.ports.assertPolicy(connection,message,row.request);
      const credentials = await this.channels.resolveCredential({organizationId:row.organization_id,connectionId:row.connection_id,
        expectedRevision:row.connection_revision,credentialRevision:row.credential_revision});
      const context = this.ports.context(connection,credentials,async () => {
        try {const current = await this.authority(row); await this.ports.assertPolicy(current.connection,current.message,row.request); await this.authority(row); physical = true;}
        catch(error){if(error instanceof PlatformError)fenceFailure=error;throw error;}
      });
      const result = await messagingChannelAdapter(connection.kind).send(row.request,context);
      await this.finish(row,result.status,result.providerMessageId,result.status === "unknown" ? "provider_acknowledgement_unknown" : null);
      // Late receipts may precede the send response; replay facts after attaching the returned provider ID.
      if (result.providerMessageId) {
        const thread=["facebook","instagram"].includes(connection.kind)?`${connection.asset_id}:${row.request.recipientId}`:row.request.recipientId;
        await this.replayReceipts(row.connection_id,connection.asset_id,thread,result.providerMessageId);
      }
    } catch (error) {
      if(fenceFailure&&!physical){await this.finish(row,"suppressed",null,fenceFailure.code);return;}
      const known = error instanceof ChannelAdapterError && error.outcome === "rejected";
      const code = error instanceof PlatformError || error instanceof ChannelAdapterError ? error.code : "CHANNEL_SEND_UNAVAILABLE";
      if (known && error.status === 429 && error.retryAfterMs !== undefined && Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>=0 && row.attempts < 5) {
        await transaction(this.pool,async db=>{
          const wait=Math.max(1000,error.retryAfterMs!);
          await db.query(`INSERT INTO agents_platform.channel_send_limits(connection_id,next_send_at) VALUES($1,now()+($2*interval '1 millisecond'))
            ON CONFLICT(connection_id) DO UPDATE SET next_send_at=greatest(channel_send_limits.next_send_at,excluded.next_send_at)`,[row.connection_id,wait]);
          await db.query(`UPDATE agents_platform.channel_outbound SET state='pending',reason=$3,available_at=now()+($4*interval '1 millisecond'),
            lease_until=NULL,updated_at=now() WHERE id=$1 AND claim_id=$2 AND state='sending'`,[row.id,row.claim_id,code,wait]);
        });
      } else await this.finish(row,known ? "failed" : !physical && error instanceof PlatformError ? "suppressed" : "unknown",null,code);
    }
  }
  private async replayReceipts(connectionId:string,assetId:string,thread:string,providerMessageId:string):Promise<void>{
    const receipts=(await this.pool.query(`SELECT * FROM agents_platform.channel_receipts WHERE connection_id=$1 AND external_conversation_id=$3
      AND (provider_message_id=$2 OR watermark IS NOT NULL) ORDER BY created_at DESC LIMIT 100`,[connectionId,providerMessageId,thread])).rows;
    for(const receipt of receipts)await this.receipt(connectionId,channelWebhookEventSchema.parse({kind:"receipt",assetId,eventId:receipt.event_id,
      externalConversationId:receipt.external_conversation_id,senderId:receipt.external_conversation_id,providerMessageId:receipt.provider_message_id,
      occurredAt:receipt.provider_occurred_at?.toISOString()??null,status:receipt.status,
      ...(receipt.watermark?{receiptWatermark:String(receipt.watermark.getTime())}:{}),...(receipt.error_code?{errorCode:receipt.error_code}:{})}));
  }
  private async finish(row: Row, state: string, providerId: string | null, reason: string | null) {
    await transaction(this.pool,async db => {
      const changed = await db.query(`UPDATE agents_platform.channel_outbound SET state=$3,provider_message_id=$4,reason=$5,lease_until=NULL,updated_at=now()
        WHERE id=$1 AND claim_id=$2 AND state='sending' RETURNING id`,[row.id,row.claim_id,state,providerId,reason]);
      if (changed.rowCount) {
        if(state==="failed")await db.query("UPDATE agents_platform.channel_outbound SET state='suppressed',reason='earlier_segment_failed',updated_at=now() WHERE message_id=$1 AND segment>$2 AND state='pending'",[row.message_id,row.segment]);
        const message = (await db.query("SELECT task_id FROM agents_platform.customer_messages WHERE id=$1",[row.message_id])).rows[0];
        if (message?.task_id) await recordEvent(db,message.task_id,`channel:send:${row.id}:${row.attempts}`,"channel.delivery",{outcome:state === "unknown" ? "uncertain" : state === "suppressed" ? "suppressed" : state === "failed" ? "failed" : "completed",count:1,
          connectionId:row.connection_id,customerMessageId:row.message_id,deliveryId:row.id});
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
  /** An explicit staff decision unblocks later messages; the uncertain receipt remains unknown and is never resent. */
  async continueAfterUnknown(scope:InboxScope,conversationId:string,deliveryId:string,expectedRevision:string) {
    await this.inbox.readStaff(scope,conversationId,"0",1);
    return transaction(this.pool,async db=>{
      const row=(await db.query(`SELECT c.ownership_generation FROM agents_platform.customer_conversations c
        JOIN agents_platform.memberships m ON m.organization_id=c.organization_id AND m.account_id=$2 AND m.revoked_at IS NULL
        JOIN agents_platform.channel_outbound o ON o.conversation_id=c.id AND o.id=$4 AND o.state='unknown'
        WHERE c.organization_id=$1 AND c.id=$3 AND c.revision=$5 AND c.assignee_account_id=$2 AND c.state='human_owned'
        FOR UPDATE OF c,o`,[scope.organizationId,scope.accountId,conversationId,deliveryId,expectedRevision])).rows[0];
      if(!row)throw new PlatformError("CHANNEL_RECOVERY_DENIED",409,"Take over the current conversation before continuing");
      await db.query(`INSERT INTO agents_platform.channel_delivery_recovery(delivery_id,actor_account_id,ownership_generation,decision)
        VALUES($1,$2,$3,'continue_without_resending') ON CONFLICT DO NOTHING`,[deliveryId,scope.accountId,row.ownership_generation]);
      return {deliveryId,state:"unknown",decision:"continue_without_resending"};
    });
  }
}
