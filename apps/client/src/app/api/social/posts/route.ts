import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
  SocialPlatform,
  SocialPostStatus,
  SocialPublishJobStatus,
} from "@kasitek/database";

export const runtime = "nodejs";

const platformValues = Object.values(SocialPlatform);
const statusValues = Object.values(SocialPostStatus);

function isValidDate(value?: string | null) {
  if (!value) return false;
  return !Number.isNaN(new Date(value).valueOf());
}

export async function GET() {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const posts = await prisma.socialPost.findMany({
      where: { userId },
      include: {
        primaryChannel: true,
        publishJobs: {
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ posts });
  } catch {
    return NextResponse.json(
      { error: "Failed to list social posts" },
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
      title?: string | null;
      prompt?: string | null;
      content?: string;
      channels?: SocialPlatform[];
      status?: SocialPostStatus;
      scheduledFor?: string | null;
      primaryChannelId?: string | null;
      metadata?: unknown;
    };

    if (!body.content?.trim()) {
      return NextResponse.json(
        { error: "Post content is required" },
        { status: 400 }
      );
    }

    const channels = (body.channels ?? []).filter((channel) =>
      platformValues.includes(channel)
    );

    if (channels.length === 0) {
      return NextResponse.json(
        { error: "At least one publishing channel is required" },
        { status: 400 }
      );
    }

    if (body.status && !statusValues.includes(body.status)) {
      return NextResponse.json(
        { error: "Invalid post status" },
        { status: 400 }
      );
    }

    if (body.scheduledFor && !isValidDate(body.scheduledFor)) {
      return NextResponse.json(
        { error: "Scheduled time is invalid" },
        { status: 400 }
      );
    }

    let primaryChannelId: string | null = null;
    if (body.primaryChannelId) {
      const channel = await prisma.socialChannelConnection.findFirst({
        where: {
          id: body.primaryChannelId,
          userId,
        },
      });

      if (!channel) {
        return NextResponse.json(
          { error: "Primary channel was not found" },
          { status: 404 }
        );
      }

      primaryChannelId = channel.id;
    }

    const post = await prisma.socialPost.create({
      data: {
        userId,
        title: body.title?.trim() || null,
        prompt: body.prompt?.trim() || null,
        content: body.content.trim(),
        channels,
        status: body.status ?? SocialPostStatus.DRAFT,
        scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
        primaryChannelId,
        metadata: body.metadata as object | undefined,
        publishJobs: {
          create: channels.map((platform) => ({
            userId,
            platform,
            status:
              body.status === SocialPostStatus.SCHEDULED
                ? SocialPublishJobStatus.QUEUED
                : SocialPublishJobStatus.PENDING,
            scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          })),
        },
      },
      include: {
        primaryChannel: true,
        publishJobs: {
          orderBy: { createdAt: "desc" },
        },
      },
    });

    return NextResponse.json({ post }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Failed to create social post" },
      { status: 500 }
    );
  }
}
