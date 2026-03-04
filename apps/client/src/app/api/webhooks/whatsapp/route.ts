import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getWhatsappWebhookQueue } from "@/lib/whatsapp/queue";

export const runtime = "nodejs";

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
    const queue = getWhatsappWebhookQueue();
    const body = (await req.json()) as {
      entry?: Array<{
        changes?: Array<{
          field?: string;
          value?: Record<string, unknown>;
        }>;
      }>;
    };

    for (const entry of body.entry || []) {
      for (const [index, change] of (entry.changes || []).entries()) {
        const value = change.value;
        if (!value) continue;

        const jobId = crypto
          .createHash("sha1")
          .update(JSON.stringify({ entry, index, field: change.field, value }))
          .digest("hex");

        await queue.add(
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
