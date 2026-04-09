import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { sendSmtpMail, verifySmtpTransport } from "@/lib/smtp";
import { prisma } from "@kasitek/database";

async function ensureTestCampaignId() {
  const existing = await prisma.outreachCampaign.findFirst({
    where: { name: "System Test Sends", category: "system-test" },
    select: { id: true },
  });
  if (existing?.id) return existing.id;

  const created = await prisma.outreachCampaign.create({
    data: {
      name: "System Test Sends",
      category: "system-test",
      status: "active",
      totalLeads: 0,
      emailsSent: 0,
      replies: 0,
    },
    select: { id: true },
  });
  return created.id;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const to = String(body?.to || session.user.email || "").trim();
  const subject = String(body?.subject || "").trim();
  const text = String(body?.text || body?.emailBody || "").trim();
  const html = body?.html ? String(body.html) : undefined;

  try {
    if (!to) {
      return NextResponse.json(
        { error: "No recipient provided and session user has no email" },
        { status: 400 }
      );
    }

    if (!subject || !text) {
      return NextResponse.json(
        { error: "Test send requires draft subject and full draft body" },
        { status: 400 }
      );
    }

    await verifySmtpTransport();

    const info = await sendSmtpMail({ to, subject, text, html });
    const testCampaignId = await ensureTestCampaignId();

    let logSaved = true;
    let logError: string | null = null;
    try {
      await prisma.outreachEmailDeliveryLog.create({
        data: {
          campaignId: testCampaignId,
          leadId: null,
          recipient: String(to).trim().toLowerCase(),
          subject,
          status: "sent",
          provider: "smtp",
          providerMessageId: info.messageId ? String(info.messageId) : null,
          providerResponse: info.response ? String(info.response) : null,
        },
      });
    } catch (e) {
      logSaved = false;
      logError = e instanceof Error ? e.message : "Unknown log write error";
      console.error("[outreach test send] log write failed:", logError);
    }

    return NextResponse.json({
      ok: true,
      to,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      logSaved,
      logError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SMTP test failed";
    if (to) {
      try {
        const testCampaignId = await ensureTestCampaignId();
        await prisma.outreachEmailDeliveryLog.create({
          data: {
            campaignId: testCampaignId,
            leadId: null,
            recipient: to.toLowerCase(),
            subject,
            status: "failed",
            provider: "smtp",
            errorMessage: message,
          },
        });
      } catch (e) {
        console.error(
          "[outreach test send] failed-log write failed:",
          e instanceof Error ? e.message : "Unknown log write error"
        );
      }
    }
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
