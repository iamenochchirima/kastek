import {
  listPendingEmailNotifications,
  markNotificationEmailFailed,
  markNotificationEmailSent,
} from "@kasitek/database";
import { Resend } from "resend";

const resendApiKey = process.env.AUTH_RESEND_KEY;
if (!resendApiKey) {
  throw new Error("AUTH_RESEND_KEY is required to run notification email worker");
}

const resend = new Resend(resendApiKey);
const pollIntervalMs = Number(process.env.NOTIFICATION_EMAIL_POLL_INTERVAL_MS || "15000");
const batchSize = Number(process.env.NOTIFICATION_EMAIL_BATCH_SIZE || "20");
const appUrl = (process.env.AUTH_URL || "http://localhost:3000").replace(/\/$/, "");
const adminUrl = (process.env.ADMIN_URL || "http://localhost:3001").replace(/\/$/, "");

let running = true;

function buildNotificationUrl(
  recipientType: string,
  entityType: string | null,
  entityId: string | null,
  payload: unknown
) {
  const eventPayload = (payload || {}) as Record<string, unknown>;
  const baseUrl = recipientType === "ADMIN" ? adminUrl : appUrl;

  if (entityType === "conversation") {
    const conversationId =
      entityId || (typeof eventPayload.conversationId === "string" ? eventPayload.conversationId : null);
    return conversationId ? `${baseUrl}/dashboard/inbox/whatsapp/${conversationId}` : null;
  }

  if (entityType === "campaign" && entityId) {
    return `${baseUrl}/dashboard/campaigns/whatsapp/${entityId}`;
  }

  if (entityType === "template") {
    return `${baseUrl}/dashboard/templates/whatsapp`;
  }

  if (entityType === "connection") {
    return `${baseUrl}/dashboard/settings`;
  }

  if (entityType === "quote_request") {
    return `${adminUrl}/dashboard/leads`;
  }

  return `${baseUrl}/dashboard/notifications`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function processBatch() {
  const pending = await listPendingEmailNotifications(batchSize);

  for (const notification of pending) {
    if (!running) return;

    if (!notification.recipientEmail) {
      await markNotificationEmailFailed({
        notificationId: notification.id,
        provider: "resend",
        errorMessage: "Recipient email address is missing",
      });
      continue;
    }

    try {
      const targetUrl = buildNotificationUrl(
        notification.recipientType,
        notification.event.entityType,
        notification.event.entityId,
        notification.event.payload
      );
      const response = await resend.emails.send({
        from: "KasiTek <onboarding@resend.dev>",
        to: notification.recipientEmail,
        subject: notification.event.title,
        html: `
          <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; color: #111827;">
            <div style="padding: 24px; border-radius: 18px; background: #0f1115; color: #f8fafc;">
              <div style="display: inline-block; margin-bottom: 16px; padding: 6px 10px; border-radius: 999px; background: rgba(196,240,77,0.12); color: #c4f04d; font-size: 11px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase;">KasiTek Notification</div>
              <h1 style="margin: 0 0 12px; font-size: 24px; line-height: 1.2;">${escapeHtml(notification.event.title)}</h1>
              <p style="margin: 0 0 16px; color: #cbd5e1; font-size: 15px; line-height: 1.6;">${escapeHtml(notification.event.message)}</p>
              <p style="margin: 0 0 20px; color: #94a3b8; font-size: 13px;">Logged at ${notification.createdAt.toLocaleString("en-ZA")}</p>
              <a href="${targetUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 999px; background: #c4f04d; color: #111827; text-decoration: none; font-weight: 700;">Open in KasiTek</a>
            </div>
          </div>
        `,
      });

      await markNotificationEmailSent({
        notificationId: notification.id,
        provider: "resend",
        providerMessageId: response.data?.id || null,
        responsePayload: response.error
          ? { error: response.error.message || "Unknown Resend error", name: response.error.name }
          : response.data
            ? { data: { id: response.data.id } }
            : undefined,
      });
    } catch (error) {
      await markNotificationEmailFailed({
        notificationId: notification.id,
        provider: "resend",
        errorMessage: error instanceof Error ? error.message : "Failed to send notification email",
      });
    }
  }
}

async function loop() {
  while (running) {
    await processBatch();
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

void loop();

process.on("SIGTERM", () => {
  running = false;
  process.exit(0);
});

process.on("SIGINT", () => {
  running = false;
  process.exit(0);
});
