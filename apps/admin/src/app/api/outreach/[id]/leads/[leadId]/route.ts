import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; leadId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { leadId } = await params;
  const body = await req.json();

  const lead = await prisma.outreachLead.update({
    where: { id: leadId },
    data: {
      ...(body.emailStatus && { emailStatus: body.emailStatus }),
      ...(body.phone !== undefined && { phone: body.phone }),
      ...(body.emailAddress !== undefined && { emailAddress: body.emailAddress }),
      ...(body.emailSentAt && { emailSentAt: new Date(body.emailSentAt) }),
      ...(body.emailTemplate !== undefined && { emailTemplate: body.emailTemplate }),
      ...(body.followUpCount !== undefined && { followUpCount: body.followUpCount }),
      ...(body.lastFollowUp && { lastFollowUp: new Date(body.lastFollowUp) }),
      ...(body.nextFollowUp !== undefined && {
        nextFollowUp: body.nextFollowUp ? new Date(body.nextFollowUp) : null,
      }),
      ...(body.notes !== undefined && { notes: body.notes }),
    },
  });

  // Update campaign counters
  const campaignId = lead.campaignId;
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

  return NextResponse.json(lead);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; leadId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, leadId } = await params;

  await prisma.outreachLead.delete({ where: { id: leadId } });

  const count = await prisma.outreachLead.count({ where: { campaignId: id } });
  await prisma.outreachCampaign.update({
    where: { id },
    data: { totalLeads: count },
  });

  return NextResponse.json({ success: true });
}
