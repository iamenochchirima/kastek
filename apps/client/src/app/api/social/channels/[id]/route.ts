import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { socialChannelPublicSelect } from "@/lib/social/db";
import {
  SocialChannelStatus,
  SocialPlatform,
} from "@kasitek/database";

export const runtime = "nodejs";

const platformValues = Object.values(SocialPlatform);
const statusValues = Object.values(SocialChannelStatus);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const existing = await prisma.socialChannelConnection.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      platform?: SocialPlatform;
      displayName?: string;
      handle?: string | null;
      status?: SocialChannelStatus;
      metadata?: unknown;
    };

    if (body.platform && !platformValues.includes(body.platform)) {
      return NextResponse.json({ error: "Invalid platform" }, { status: 400 });
    }

    if (body.status && !statusValues.includes(body.status)) {
      return NextResponse.json({ error: "Invalid channel status" }, { status: 400 });
    }

    const channel = await prisma.socialChannelConnection.update({
      where: { id },
      data: {
        platform: body.platform ?? existing.platform,
        displayName: body.displayName?.trim() || existing.displayName,
        handle: body.handle === undefined ? existing.handle : body.handle?.trim() || null,
        status: body.status ?? existing.status,
        metadata: body.metadata === undefined ? existing.metadata ?? undefined : (body.metadata as object | undefined),
      },
      select: socialChannelPublicSelect,
    });

    return NextResponse.json({ channel });
  } catch {
    return NextResponse.json(
      { error: "Failed to update social channel" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const existing = await prisma.socialChannelConnection.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Channel not found" }, { status: 404 });
    }

    await prisma.socialChannelConnection.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete social channel" },
      { status: 500 },
    );
  }
}
