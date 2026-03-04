import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const emailStatus = searchParams.get("emailStatus");
  const search = searchParams.get("search");

  const where: Record<string, unknown> = { campaignId: id };
  if (emailStatus) where.emailStatus = emailStatus;
  if (search) {
    where.OR = [
      { businessName: { contains: search, mode: "insensitive" } },
      { website: { contains: search, mode: "insensitive" } },
      { emailAddress: { contains: search, mode: "insensitive" } },
    ];
  }

  const leads = await prisma.outreachLead.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(leads);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json();

  const campaign = await prisma.outreachCampaign.findUnique({ where: { id } });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Support bulk import: body.listings is an array
  if (Array.isArray(body.listings)) {
    const data = body.listings.map(
      (l: { name: string; website?: string; address?: string; bizbayUrl?: string; phone?: string; email?: string }) => ({
        campaignId: id,
        businessName: l.name,
        website: l.website || null,
        address: l.address || null,
        bizbayUrl: l.bizbayUrl || null,
        phone: l.phone || null,
        emailAddress: l.email || null,
        category: campaign.category,
      })
    );

    const result = await prisma.outreachLead.createMany({ data });

    const count = await prisma.outreachLead.count({ where: { campaignId: id } });
    await prisma.outreachCampaign.update({
      where: { id },
      data: { totalLeads: count },
    });

    return NextResponse.json({ imported: result.count, totalLeads: count }, { status: 201 });
  }

  // Single lead add
  const lead = await prisma.outreachLead.create({
    data: {
      campaignId: id,
      businessName: body.businessName,
      website: body.website || null,
      address: body.address || null,
      bizbayUrl: body.bizbayUrl || null,
      phone: body.phone || null,
      emailAddress: body.emailAddress || null,
      category: campaign.category,
    },
  });

  const count = await prisma.outreachLead.count({ where: { campaignId: id } });
  await prisma.outreachCampaign.update({
    where: { id },
    data: { totalLeads: count },
  });

  return NextResponse.json(lead, { status: 201 });
}
