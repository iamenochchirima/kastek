import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const source = searchParams.get("source");

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (source) where.source = source;

  const leads = await prisma.quoteRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(leads);
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  const lead = await prisma.quoteRequest.create({
    data: {
      businessName: body.businessName,
      contactPerson: body.contactPerson,
      phone: body.phone,
      email: body.email,
      businessType: body.businessType || "other",
      services: body.services || [],
      description: body.description || null,
      source: body.source || "facebook",
      status: body.status || "new",
      quoteAmount: body.quoteAmount || null,
      followUpDate: body.followUpDate ? new Date(body.followUpDate) : null,
      notes: [],
    },
  });

  return NextResponse.json(lead, { status: 201 });
}
