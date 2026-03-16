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
const statusValues = Object.values(SocialPostStatus);
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
      variants?: Array<{
        platform: SocialPlatform;
        content: string;
        status?: SocialVariantStatus;
        aiGenerated?: boolean;
        metadata?: unknown;
      }>;
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

    const normalizedVariants = normalizeVariants({
      variants: body.variants,
      channels,
      fallbackContent: body.content.trim(),
    });

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
        variants: {
          create: normalizedVariants,
        },
        publishJobs: {
          create: normalizedVariants.map((variant) => ({
            userId,
            platform: variant.platform,
            status:
              body.status === SocialPostStatus.SCHEDULED
                ? SocialPublishJobStatus.QUEUED
                : SocialPublishJobStatus.PENDING,
            scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
          })),
        },
      },
    });

    const savedVariants = await prisma.socialPostVariant.findMany({
      where: { postId: post.id },
    });

    await prisma.$transaction(
      savedVariants.map((variant) =>
        prisma.socialPublishJob.updateMany({
          where: {
            postId: post.id,
            platform: variant.platform,
            variantId: null,
          },
          data: {
            variantId: variant.id,
          },
        }),
      ),
    );

    const hydratedPost = await prisma.socialPost.findUnique({
      where: { id: post.id },
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

    return NextResponse.json({ post: hydratedPost }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Failed to create social post" },
      { status: 500 }
    );
  }
}
