import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { createWhatsappCampaign } from "@/lib/whatsapp/campaign-service";
import type { CreateWhatsappCampaignInput } from "@/lib/whatsapp/types";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const campaigns = await prisma.whatsappCampaign.findMany({
      where: { userId },
      include: {
        connection: {
          select: {
            id: true,
            phoneNumberId: true,
            phoneDisplayNumber: true,
            wabaId: true,
            currentQualityRating: true,
            dailyLimitEstimate: true,
            verified: true,
          },
        },
        template: {
          select: {
            id: true,
            templateName: true,
            language: true,
            category: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ campaigns });
  } catch {
    return NextResponse.json(
      { error: "Failed to list campaigns" },
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

    const body = (await req.json()) as CreateWhatsappCampaignInput;

    const result = await createWhatsappCampaign(userId, body);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Failed to create campaign" },
      { status: 500 }
    );
  }
}
