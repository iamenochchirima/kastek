import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  cancelWhatsappCampaign,
  pauseWhatsappCampaign,
  resumeWhatsappCampaign,
  retryFailedWhatsappCampaign,
} from "@/lib/whatsapp/campaign-service";
import type { UpdateWhatsappCampaignAction } from "@/lib/whatsapp/types";

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

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      action?: UpdateWhatsappCampaignAction;
      scheduledAt?: string;
    };

    if (!body.action) {
      return NextResponse.json({ error: "Action is required" }, { status: 400 });
    }

    if (body.action === "pause") {
      return NextResponse.json(await pauseWhatsappCampaign(userId, id));
    }

    if (body.action === "resume") {
      return NextResponse.json(
        await resumeWhatsappCampaign(userId, id, {
          scheduledAt: body.scheduledAt || null,
        })
      );
    }

    if (body.action === "cancel") {
      return NextResponse.json(await cancelWhatsappCampaign(userId, id));
    }

    if (body.action === "retry_failed") {
      return NextResponse.json(await retryFailedWhatsappCampaign(userId, id));
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update campaign";
    const status =
      message.includes("not found")
        ? 404
        : message.includes("daily portfolio limit")
          ? 409
          : 400;

    return NextResponse.json({ error: message }, { status });
  }
}
