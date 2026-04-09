import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@kasitek/database";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const channel = searchParams.get("channel");
  const search = searchParams.get("search");

  const where: Record<string, unknown> = {};
  if (channel) where.channel = channel;
  if (search) {
    where.OR = [
      { customerName: { contains: search, mode: "insensitive" } },
      { customerIdentifier: { contains: search } },
    ];
  }

  const conversations = await prisma.conversation.findMany({
    where,
    orderBy: { lastMessageAt: "desc" },
    include: {
      messages: {
        orderBy: { timestamp: "desc" },
        take: 1,
      },
    },
  });

  return NextResponse.json(conversations);
}
