import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const callStatus = searchParams.get("callStatus");
  const category = searchParams.get("category");
  const search = searchParams.get("search");

  const where: Record<string, unknown> = {};
  if (callStatus) where.callStatus = callStatus;
  if (category) where.category = category;
  if (search) {
    where.OR = [
      { businessName: { contains: search, mode: "insensitive" } },
      { address: { contains: search, mode: "insensitive" } },
    ];
  }

  const leads = await prisma.webServiceLead.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });

  return NextResponse.json(leads);
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await prisma.webServiceLead.deleteMany({});
  return NextResponse.json({ deleted: result.count });
}
