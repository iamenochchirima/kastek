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

async function getScopedPost(userId: string, id: string) {
  return prisma.socialPost.findFirst({
    where: { id, userId },
    include: {
      primaryChannel: true,
      publishJobs: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

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
    const post = await getScopedPost(userId, id);

    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    return NextResponse.json({ post });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch social post" },
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
    const existing = await prisma.socialPost.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
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

    if (body.content !== undefined && !body.content.trim()) {
      return NextResponse.json(
        { error: "Post content cannot be empty" },
        { status: 400 }
      );
    }

    const channels =
      body.channels === undefined
        ? existing.channels
        : body.channels.filter((channel) => platformValues.includes(channel));

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

    let primaryChannelId = existing.primaryChannelId;
    if (body.primaryChannelId !== undefined) {
      if (body.primaryChannelId === null) {
        primaryChannelId = null;
      } else {
        const channel = await prisma.socialChannelConnection.findFirst({
          where: { id: body.primaryChannelId, userId },
        });

        if (!channel) {
          return NextResponse.json(
            { error: "Primary channel was not found" },
            { status: 404 }
          );
        }

        primaryChannelId = channel.id;
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.socialPost.update({
        where: { id },
        data: {
          title: body.title === undefined ? existing.title : body.title?.trim() || null,
          prompt:
            body.prompt === undefined ? existing.prompt : body.prompt?.trim() || null,
          content: body.content === undefined ? existing.content : body.content.trim(),
          channels,
          status: body.status ?? existing.status,
          scheduledFor:
            body.scheduledFor === undefined
              ? existing.scheduledFor
              : body.scheduledFor
                ? new Date(body.scheduledFor)
                : null,
          primaryChannelId,
          metadata:
            body.metadata === undefined
              ? existing.metadata ?? undefined
              : (body.metadata as object | undefined),
        },
      });

      await tx.socialPublishJob.deleteMany({
        where: { postId: id },
      });

      await tx.socialPublishJob.createMany({
        data: channels.map((platform) => ({
          userId,
          postId: id,
          platform,
          status:
            (body.status ?? existing.status) === SocialPostStatus.SCHEDULED
              ? SocialPublishJobStatus.QUEUED
              : SocialPublishJobStatus.PENDING,
          scheduledFor:
            body.scheduledFor === undefined
              ? existing.scheduledFor
              : body.scheduledFor
                ? new Date(body.scheduledFor)
                : null,
        })),
      });
    });

    const post = await getScopedPost(userId, id);

    return NextResponse.json({ post });
  } catch {
    return NextResponse.json(
      { error: "Failed to update social post" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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

    const existing = await prisma.socialPost.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    await prisma.socialPost.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete social post" },
      { status: 500 }
    );
  }
}
