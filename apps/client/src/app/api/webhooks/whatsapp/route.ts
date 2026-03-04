import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getWhatsappWebhookQueue } from "@/lib/whatsapp/queue";
import { processWhatsappWebhookChange } from "@/lib/whatsapp/webhook-service";

export const runtime = "nodejs";
const WEBHOOK_DEBUG = process.env.WHATSAPP_WEBHOOK_DEBUG === "1";
const PROCESS_INLINE =
  process.env.NODE_ENV !== "production" &&
  process.env.WHATSAPP_WEBHOOK_USE_QUEUE !== "1";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  }

  if (token !== process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
    return NextResponse.json({ error: "Invalid verify token" }, { status: 403 });
  }

  return new Response(challenge, { status: 200 });
}

export async function POST(req: Request) {
  try {
    const queue = PROCESS_INLINE ? null : getWhatsappWebhookQueue();
    const body = (await req.json()) as {
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: Record<string, unknown>;
        }>;
      }>;
    };
    let queuedCount = 0;

    if (WEBHOOK_DEBUG) {
      console.info("[whatsapp:webhook:route] received", {
        entries: body.entry?.length || 0,
      });
    }

    for (const [entryIndex, entry] of (body.entry || []).entries()) {
      if (WEBHOOK_DEBUG) {
        console.info("[whatsapp:webhook:route] entry", {
          entryIndex,
          changes: entry.changes?.length || 0,
        });
      }

      for (const [index, change] of (entry.changes || []).entries()) {
        const value = change.value;
        if (!value) continue;

        const jobId = crypto
          .createHash("sha1")
          .update(JSON.stringify({ entry, index, field: change.field, value }))
          .digest("hex");

        if (PROCESS_INLINE) {
          await processWhatsappWebhookChange({
            field: change.field,
            value,
          });
        } else {
          await queue!.add(
            "process-webhook-change",
            {
              field: change.field,
              value,
            },
            {
              jobId,
            }
          );
        }
        queuedCount += 1;

        if (WEBHOOK_DEBUG) {
          console.info("[whatsapp:webhook:route] queued", {
            entryIndex,
            changeIndex: index,
            field: change.field || "unknown",
            jobId,
            processingMode: PROCESS_INLINE ? "inline" : "queue",
            valueKeys: Object.keys(value),
            hasMessages: Array.isArray((value as { messages?: unknown }).messages),
            hasStatuses: Array.isArray((value as { statuses?: unknown }).statuses),
          });
        }
      }
    }

    if (WEBHOOK_DEBUG) {
      console.info("[whatsapp:webhook:route] completed", {
        queuedCount,
      });
    }

    return NextResponse.json({ success: true, queued: true });
  } catch (error) {
    console.error("WhatsApp webhook processing error", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 }
    );
  }
}
