import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const campaign = await prisma.whatsappCampaign.findFirst({
      where: {
        id,
        userId,
      },
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
            header: true,
            body: true,
            footer: true,
            buttons: true,
            variablesCount: true,
          },
        },
        recipients: {
          include: {
            contact: {
              select: {
                id: true,
                phone: true,
                fullName: true,
                tags: true,
                location: true,
                optIn: true,
                excluded: true,
                lastMarketingSent: true,
              },
            },
          },
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    if (!campaign) {
      return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
    }

    return NextResponse.json({ campaign });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch campaign" },
      { status: 500 }
    );
  }
}
