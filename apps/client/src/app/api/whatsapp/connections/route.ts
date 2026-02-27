import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const connections = await prisma.whatsappConnection.findMany({
      where: { userId },
      select: {
        id: true,
        userId: true,
        phoneNumberId: true,
        phoneDisplayNumber: true,
        wabaId: true,
        currentQualityRating: true,
        dailyLimitEstimate: true,
        verified: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ connections });
  } catch {
    return NextResponse.json(
      { error: "Failed to list WhatsApp connections" },
      { status: 500 }
    );
  }
}
