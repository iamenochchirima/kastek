import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasiai/database";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const campaigns = await prisma.outreachCampaign.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { leads: true } },
    },
  });

  return NextResponse.json(campaigns);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const campaign = await prisma.outreachCampaign.create({
    data: {
      name: body.name,
      category: body.category,
      status: body.status || "draft",
    },
  });

  return NextResponse.json(campaign, { status: 201 });
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Delete all leads first (cascade), then campaigns
  await prisma.outreachLead.deleteMany({});
  const result = await prisma.outreachCampaign.deleteMany({});
  return NextResponse.json({ deleted: result.count });
}
