import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  Prisma,
  SocialChannelStatus,
  SocialPlatform,
} from "@kasitek/database";

export const runtime = "nodejs";

const platformValues = Object.values(SocialPlatform);
const statusValues = Object.values(SocialChannelStatus);

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const channels = await prisma.socialChannelConnection.findMany({
      where: { userId },
      orderBy: [{ platform: "asc" }, { createdAt: "desc" }],
    });

    return NextResponse.json({ channels });
  } catch {
    return NextResponse.json(
      { error: "Failed to list social channels" },
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

    const body = (await req.json().catch(() => ({}))) as {
      platform?: SocialPlatform;
      displayName?: string;
      handle?: string | null;
      externalAccountId?: string | null;
      status?: SocialChannelStatus;
      metadata?: unknown;
    };

    if (!body.platform || !platformValues.includes(body.platform)) {
      return NextResponse.json(
        { error: "A valid platform is required" },
        { status: 400 }
      );
    }

    if (!body.displayName?.trim()) {
      return NextResponse.json(
        { error: "Display name is required" },
        { status: 400 }
      );
    }

    if (body.status && !statusValues.includes(body.status)) {
      return NextResponse.json(
        { error: "Invalid channel status" },
        { status: 400 }
      );
    }

    const channel = await prisma.socialChannelConnection.create({
      data: {
        userId,
        platform: body.platform,
        displayName: body.displayName.trim(),
        handle: body.handle?.trim() || null,
        externalAccountId: body.externalAccountId?.trim() || null,
        status: body.status ?? SocialChannelStatus.CONNECTED,
        metadata: body.metadata as object | undefined,
      },
    });

    return NextResponse.json({ channel }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "This social channel is already connected" },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: "Failed to create social channel" },
      { status: 500 }
    );
  }
}
