import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";
import { sendSmtpMail, verifySmtpTransport } from "@/lib/smtp";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; leadId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: campaignId, leadId } = await params;

  const lead = await prisma.outreachLead.findFirst({
    where: { id: leadId, campaignId },
  });

  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const body = await req.json();
  const rawTo = body.to;
  const toList = Array.isArray(rawTo)
    ? rawTo.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean)
    : String(rawTo || "").trim()
      ? [String(rawTo).trim().toLowerCase()]
      : [];
  const fallbackLeadEmail = String(lead.emailAddress || "").trim();
  const to = Array.from(new Set(toList.length ? toList : fallbackLeadEmail ? [fallbackLeadEmail.toLowerCase()] : []));
  const primaryTo = String(body.primaryTo || to[0] || "").trim();
  const subject = String(body.subject || "").trim();
  const emailText = String(body.text || body.emailBody || "").trim();
  const emailHtml = body.html ? String(body.html) : undefined;

  if (!to.length) {
    return NextResponse.json({ error: "Lead has no email address" }, { status: 400 });
  }
  if (!subject || !emailText) {
    return NextResponse.json(
      { error: "subject and text/emailBody are required" },
      { status: 400 }
    );
  }

  try {
    await verifySmtpTransport();
    const info = await sendSmtpMail({
      to: to.join(", "),
      subject,
      text: emailText,
      ...(emailHtml ? { html: emailHtml } : {}),
    });

    const rejectedSet = new Set(
      (info.rejected || []).map((entry: unknown) => String(entry || "").trim().toLowerCase())
    );

    const updatedLead = await prisma.outreachLead.update({
      where: { id: leadId },
      data: {
        emailStatus: "sent",
        emailSentAt: new Date(),
        emailAddress: primaryTo || to[0] || null,
        emailTemplate: emailText,
      },
    });

    if (to.length > 0) {
      await prisma.outreachEmailDeliveryLog.createMany({
        data: to.map((recipient) => ({
          campaignId,
          leadId,
          recipient,
          subject,
          status: rejectedSet.has(recipient) ? "failed" : "sent",
          provider: "smtp",
          providerMessageId: info.messageId ? String(info.messageId) : null,
          providerResponse: info.response ? String(info.response) : null,
          errorMessage: rejectedSet.has(recipient) ? "Rejected by SMTP provider" : null,
        })),
      });
    }

    const [sentCount, repliedCount] = await Promise.all([
      prisma.outreachLead.count({ where: { campaignId, emailStatus: "sent" } }),
      prisma.outreachLead.count({
        where: {
          campaignId,
          emailStatus: { in: ["replied", "interested"] },
        },
      }),
    ]);

    await prisma.outreachCampaign.update({
      where: { id: campaignId },
      data: { emailsSent: sentCount, replies: repliedCount },
    });

    return NextResponse.json({
      ok: true,
      lead: updatedLead,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Send failed";
    await prisma.outreachLead.update({
      where: { id: leadId },
      data: {
        emailStatus: "pending",
        notes: [lead.notes, `Send failed: ${message}`].filter(Boolean).join("\n"),
      },
    });

    if (to.length > 0) {
      await prisma.outreachEmailDeliveryLog.createMany({
        data: to.map((recipient) => ({
          campaignId,
          leadId,
          recipient,
          subject,
          status: "failed",
          provider: "smtp",
          errorMessage: message,
        })),
      });
    }

    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
