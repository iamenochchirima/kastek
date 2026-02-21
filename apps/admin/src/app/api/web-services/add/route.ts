import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasiai/database";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();

  if (!body.businessName || !body.category) {
    return NextResponse.json(
      { error: "businessName and category are required" },
      { status: 400 }
    );
  }

  const lead = await prisma.webServiceLead.create({
    data: {
      businessName: body.businessName,
      category: body.category,
      website: body.website || null,
      address: body.address || null,
      bizbayUrl: body.bizbayUrl || null,
      phone: body.phone || null,
      email: body.email || null,
      notes: body.notes || null,
    },
  });

  return NextResponse.json(lead, { status: 201 });
}
