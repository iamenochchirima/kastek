import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const connections = await prisma.whatsappConnection.findMany({
    where: { userId },
    select: { id: true },
  });

  if (connections.length === 0) {
    return NextResponse.json({ unreadCount: 0 });
  }

  const result = await prisma.conversation.aggregate({
    where: {
      channel: "whatsapp",
      OR: connections.map((connection) => ({
        customerIdentifier: {
          startsWith: `wa:${connection.id}:`,
        },
      })),
    },
    _sum: {
      unreadCount: true,
    },
  });

  return NextResponse.json({ unreadCount: result._sum.unreadCount || 0 });
}
