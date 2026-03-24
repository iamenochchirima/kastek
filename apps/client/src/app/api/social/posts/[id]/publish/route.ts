import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  SocialPlatform,
} from "@kasitek/database";
import {
  claimPublishJob,
  executeSocialPublishJob,
  getUserScopedPostWithJobs,
} from "@/lib/social/publish-service";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(
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
    const body = (await req.json().catch(() => ({}))) as {
      platform?: SocialPlatform;
    };
    const requestedPlatform = body.platform || SocialPlatform.X;
    const supportedPlatforms = [SocialPlatform.X, SocialPlatform.LINKEDIN] as const;

    if (!supportedPlatforms.includes(requestedPlatform as (typeof supportedPlatforms)[number])) {
      return NextResponse.json(
        { error: `Manual publishing is not available yet for ${requestedPlatform}` },
        { status: 400 },
      );
    }
    const platform = requestedPlatform as (typeof supportedPlatforms)[number];

    const post = await prisma.socialPost.findFirst({
      where: { id, userId },
      include: {
        publishJobs: true,
      },
    });

    if (!post) {
      return NextResponse.json({ error: "Post not found" }, { status: 404 });
    }

    if (!post.channels.includes(platform)) {
      return NextResponse.json(
        { error: `This post is not configured for ${platform}` },
        { status: 400 },
      );
    }

    const existingPublishedJob = post.publishJobs.find(
      (job) =>
        job.platform === platform &&
        job.status === "PUBLISHED" &&
        job.externalPostId,
    );

    if (existingPublishedJob) {
      return NextResponse.json(
        { error: `This post has already been published to ${platform}` },
        { status: 409 },
      );
    }

    let job = post.publishJobs.find((item) => item.platform === platform);
    if (!job) {
      job = await prisma.socialPublishJob.create({
        data: {
          userId,
          postId: post.id,
          platform,
          status: "PENDING",
        },
      });
    }

    const claimed = await claimPublishJob(job.id, ["PENDING", "FAILED", "QUEUED"]);
    if (!claimed) {
      return NextResponse.json(
        { error: "This publish job is already being processed" },
        { status: 409 },
      );
    }

    const result = await executeSocialPublishJob(job.id);
    const refreshedPost = await getUserScopedPostWithJobs(userId, id);

    return NextResponse.json({
      post: refreshedPost,
      result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to publish social post";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
