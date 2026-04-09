import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { name, category, listings } = body;

  if (!name || !category || !Array.isArray(listings) || listings.length === 0) {
    return NextResponse.json(
      { error: "name, category, and listings[] are required" },
      { status: 400 }
    );
  }

  // Check for duplicate category
  const existing = await prisma.outreachCampaign.findFirst({
    where: { category: { equals: category, mode: "insensitive" } },
  });

  if (existing) {
    return NextResponse.json(
      { error: `A campaign for "${category}" already exists: "${existing.name}"` },
      { status: 409 }
    );
  }

  // Create campaign and import all leads in a transaction
  const campaign = await prisma.$transaction(async (tx) => {
    const campaign = await tx.outreachCampaign.create({
      data: {
        name,
        category,
        status: "draft",
        totalLeads: listings.length,
      },
    });

    await tx.outreachLead.createMany({
      data: listings.map(
        (l: { name: string; website?: string; address?: string; bizbayUrl?: string; email?: string; phone?: string }) => ({
          campaignId: campaign.id,
          businessName: l.name,
          website: l.website || null,
          address: l.address || null,
          bizbayUrl: l.bizbayUrl || null,
          emailAddress: l.email || null,
          phone: l.phone || null,
          category,
        })
      ),
    });

    return campaign;
  });

  return NextResponse.json(campaign, { status: 201 });
}
