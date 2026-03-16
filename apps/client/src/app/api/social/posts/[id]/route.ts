import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { socialChannelPublicSelect } from "@/lib/social/db";
import {
  SocialPlatform,
  SocialPostStatus,
  SocialPublishJobStatus,
  SocialVariantStatus,
} from "@kasitek/database";

export const runtime = "nodejs";

const platformValues = Object.values(SocialPlatform);
const postStatusValues = Object.values(SocialPostStatus);
const variantStatusValues = Object.values(SocialVariantStatus);

function isValidDate(value?: string | null) {
  if (!value) return false;
  return !Number.isNaN(new Date(value).valueOf());
}

function normalizeVariants({
  variants,
  channels,
  fallbackContent,
}: {
  variants:
    | Array<{
        platform: SocialPlatform;
        content: string;
        status?: SocialVariantStatus;
        aiGenerated?: boolean;
        metadata?: unknown;
      }>
    | undefined;
  channels: SocialPlatform[];
  fallbackContent: string;
}) {
  return channels.map((platform) => {
    const existing = variants?.find((variant) => variant.platform === platform);

    return {
      platform,
      content: existing?.content?.trim() || fallbackContent,
      status:
        existing?.status && variantStatusValues.includes(existing.status)
          ? existing.status
          : SocialVariantStatus.DRAFT,
      aiGenerated: Boolean(existing?.aiGenerated),
      metadata: (existing?.metadata as object | undefined) || undefined,
    };
  });
}

async function getScopedPost(userId: string, id: string) {
  return prisma.socialPost.findFirst({
    where: { id, userId },
    include: {
      primaryChannel: {
        select: socialChannelPublicSelect,
      },
      variants: {
        orderBy: { createdAt: "asc" },
      },
      publishJobs: {
        orderBy: { createdAt: "desc" },
      },
    },
  });
}

export async function GET(
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
    const post = await getScopedPost(userId, id);

    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    return NextResponse.json({ post });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch social post" },
      { status: 500 },
    );
  }
}

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
    const existing = await prisma.socialPost.findFirst({
      where: { id, userId },
      include: { variants: true },
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
      variants?: Array<{
        platform: SocialPlatform;
        content: string;
        status?: SocialVariantStatus;
        aiGenerated?: boolean;
        metadata?: unknown;
      }>;
      metadata?: unknown;
    };

    if (body.content !== undefined && !body.content.trim()) {
      return NextResponse.json(
        { error: "Post content cannot be empty" },
        { status: 400 },
      );
    }

    const channels =
      body.channels === undefined
        ? existing.channels
        : body.channels.filter((channel) => platformValues.includes(channel));

    if (channels.length === 0) {
      return NextResponse.json(
        { error: "At least one publishing channel is required" },
        { status: 400 },
      );
    }

    if (body.status && !postStatusValues.includes(body.status)) {
      return NextResponse.json(
        { error: "Invalid post status" },
        { status: 400 },
      );
    }

    if (body.scheduledFor && !isValidDate(body.scheduledFor)) {
      return NextResponse.json(
        { error: "Scheduled time is invalid" },
        { status: 400 },
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
            { status: 404 },
          );
        }

        primaryChannelId = channel.id;
      }
    }

    const nextContent =
      body.content === undefined ? existing.content : body.content.trim();
    const normalizedVariants = normalizeVariants({
      variants: body.variants,
      channels,
      fallbackContent: nextContent,
    });
    const nextStatus = body.status ?? existing.status;
    const nextScheduledFor =
      body.scheduledFor === undefined
        ? existing.scheduledFor
        : body.scheduledFor
          ? new Date(body.scheduledFor)
          : null;

    await prisma.$transaction(async (tx) => {
      await tx.socialPost.update({
        where: { id },
        data: {
          title: body.title === undefined ? existing.title : body.title?.trim() || null,
          prompt: body.prompt === undefined ? existing.prompt : body.prompt?.trim() || null,
          content: nextContent,
          channels,
          status: nextStatus,
          scheduledFor: nextScheduledFor,
          primaryChannelId,
          metadata:
            body.metadata === undefined
              ? existing.metadata ?? undefined
              : (body.metadata as object | undefined),
        },
      });

      await tx.socialPostVariant.deleteMany({
        where: { postId: id },
      });

      await tx.socialPostVariant.createMany({
        data: normalizedVariants.map((variant) => ({
          postId: id,
          platform: variant.platform,
          content: variant.content,
          status: variant.status,
          aiGenerated: variant.aiGenerated,
          metadata: variant.metadata,
        })),
      });

      await tx.socialPublishJob.deleteMany({
        where: { postId: id },
      });

      const savedVariants = await tx.socialPostVariant.findMany({
        where: { postId: id },
      });

      await tx.socialPublishJob.createMany({
        data: savedVariants.map((variant) => ({
          userId,
          postId: id,
          variantId: variant.id,
          platform: variant.platform,
          status:
            nextStatus === SocialPostStatus.SCHEDULED
              ? SocialPublishJobStatus.QUEUED
              : SocialPublishJobStatus.PENDING,
          scheduledFor: nextScheduledFor,
        })),
      });
    });

    const post = await getScopedPost(userId, id);
    return NextResponse.json({ post });
  } catch {
    return NextResponse.json(
      { error: "Failed to update social post" },
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
      { status: 500 },
    );
  }
}
