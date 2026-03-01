import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { connectManualWhatsappConnection } from "@/lib/whatsapp/onboarding-service";

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

export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      wabaId?: string;
      phoneNumberId?: string;
      accessToken?: string;
      phoneDisplayNumber?: string;
    };

    const result = await connectManualWhatsappConnection({
      userId,
      wabaId: body.wabaId || "",
      phoneNumberId: body.phoneNumberId || "",
      accessToken: body.accessToken || "",
      phoneDisplayNumber: body.phoneDisplayNumber,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save WhatsApp connection";
    const status = message.includes("already connected") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
